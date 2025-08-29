/**
 * @file /src/Plugins/Pagination.ts
 * @name Pagination
 * @description Optimized pagination plugin: throttled, idle-scheduled, IME-aware, incremental.
 */

import { Editor } from "@tiptap/core";
import { Plugin, PluginKey, EditorState, Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { buildPageView } from "../utils/buildPageView"; // <- incremental version you integrated
import { isNodeEmpty } from "../utils/nodes/node";
import { doesDocHavePageNodes } from "../utils/nodes/page/page";
import { PaginationOptions } from "../PaginationExtension";
import { ySyncPluginKey } from "y-prosemirror";

/** Config */
const THROTTLE_MS = 120; // trailing throttle for bursts
const IDLE_TIMEOUT_MS = 200; // idle scheduling timeout
const MAX_REMOTE_BATCHES = 50;

function countPageNodes(doc: EditorState["doc"]): number {
    let c = 0;
    doc.descendants((node) => {
        if ((node as any).type?.name === "page") c++;
    });
    return c;
}

function rangeTouchesPageNode(prevDoc: EditorState["doc"], from: number, to: number): boolean {
    let touched = false;
    const lo = Math.max(0, from - 1);
    const hi = Math.min(prevDoc.content.size, to + 1);
    prevDoc.nodesBetween(lo, hi, (node) => {
        if ((node as any).type?.name === "page") {
            touched = true;
            return false; // stop early
        }
        return true;
    });
    return touched;
}

type PaginationPluginProps = {
    editor: Editor;
    options: PaginationOptions;
};

type IdleDeadline = { didTimeout: boolean; timeRemaining(): number };
type IdleCallback = (deadline: IdleDeadline) => void;

/** Schedule work in idle time; returns a cancel function (no global type augmentation) */
function scheduleIdle(cb: IdleCallback, timeout = IDLE_TIMEOUT_MS): () => void {
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        const id = (window as any).requestIdleCallback(cb, { timeout });
        return () => {
            try {
                (window as any).cancelIdleCallback?.(id);
            } catch {
                /* noop */
            }
        };
    }
    if (typeof requestAnimationFrame === "function") {
        const id = requestAnimationFrame(() => cb({ didTimeout: false, timeRemaining: () => 0 }));
        return () => cancelAnimationFrame(id);
    }
    //@ts-ignore
    const id = window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), timeout);
    return () => clearTimeout(id);
}

type InternalState = {
    isPaginating: boolean;
    throttleTimer: number | null;
    idleCancel: null | (() => void);
    queued: boolean;

    composing: boolean; // IME in progress
    remoteBatchCount: number; // guard against remote storms
    pendingFrom: number | null; // coalesced changed range (old doc positions)
    pendingTo: number | null;
};

const key = new PluginKey<InternalState>("pagination");

const docReallyChanged = (prev: EditorState, next: EditorState) => !prev.doc.eq(next.doc);

/** find change range between old and new docs (positions are in the OLD doc) */
function findChangedRangeInOldDoc(oldState: EditorState, newState: EditorState) {
    const start = oldState.doc.content.findDiffStart(newState.doc.content);
    if (start == null) return null;
    const end = oldState.doc.content.findDiffEnd(newState.doc.content);
    // end?.a is the end position in the OLD doc; end?.b is in the NEW doc
    return { from: start, to: end ? end.a : start + 1 };
}

/** coalesce ranges across multiple rapid updates before we actually paginate */
function accumulateRange(st: InternalState, from: number | null, to: number | null) {
    if (from == null || to == null) return;
    if (st.pendingFrom == null || from < st.pendingFrom) st.pendingFrom = from;
    if (st.pendingTo == null || to > st.pendingTo) st.pendingTo = to;
}

function schedulePagination(view: EditorView, run: () => void) {
    const st = key.getState(view.state)!;

    const schedule = () => {
        if (st.queued) return;
        st.queued = true;

        if (st.idleCancel) {
            st.idleCancel();
            st.idleCancel = null;
        }

        st.idleCancel = scheduleIdle(() => {
            st.idleCancel = null;
            st.queued = false;
            run();
        });
    };

    if (st.throttleTimer != null) clearTimeout(st.throttleTimer);
    st.throttleTimer = window.setTimeout(() => {
        st.throttleTimer = null;
        schedule();
    }, THROTTLE_MS);
}

const PaginationPlugin = ({ editor, options }: PaginationPluginProps) =>
    new Plugin<InternalState>({
        key,

        state: {
            init: () => ({
                isPaginating: false,
                throttleTimer: null,
                idleCancel: null,
                queued: false,

                composing: false,
                remoteBatchCount: 0,
                pendingFrom: null,
                pendingTo: null,
            }),

            apply(tr: Transaction, value: InternalState) {
                // We don't need to derive anything complex here; we coalesce ranges in view.update().
                // Keep IME flag if set by meta (rare) — main source is DOM events below.
                const composingMeta = (tr as any).isComposing === true || (tr.getMeta("composition") as boolean) === true;

                if (!composingMeta) return value;
                return { ...value, composing: true };
            },
        },

        /** NOTE: We don't need to build or modify transactions; return null to satisfy TS. */
        appendTransaction(_transactions: readonly Transaction[], _old: EditorState, _new: EditorState) {
            return null;
        },

        view(view: EditorView) {
            // IME listeners
            const onCompositionStart = () => {
                const st = key.getState(view.state);
                if (st) st.composing = true;
            };
            const onCompositionEnd = () => {
                const st = key.getState(view.state);
                if (st) st.composing = false;
            };
            view.dom.addEventListener("compositionstart", onCompositionStart);
            view.dom.addEventListener("compositionend", onCompositionEnd);

            return {
                update(v: EditorView, prevState: EditorState) {
                    const st = key.getState(v.state)!;
                    const state = v.state;
                    const { doc, schema } = state;

                    // Must have page node in schema
                    if (!schema.nodes.page) return;

                    // Skip if document didn't change (selection-only updates)
                    const changed = docReallyChanged(prevState, state);
                    const initialLoad = isNodeEmpty(prevState.doc) && !isNodeEmpty(doc);
                    const hasPageNodes = doesDocHavePageNodes(state);
                    if (!changed && hasPageNodes && !initialLoad) return;

                    // IME: don't paginate mid-composition — queue for after
                    if (st.composing) {
                        schedulePagination(v, runPagination);
                        return;
                    }

                    // ---- NEW: detect page-boundary deletions and force full rebuild ----
                    const prevPageCount = countPageNodes(prevState.doc);
                    const nextPageCount = countPageNodes(state.doc);
                    const isDeletion = state.doc.content.size < prevState.doc.content.size;

                    // Accumulate changed range (in OLD doc positions)
                    const diff = findChangedRangeInOldDoc(prevState, state);
                    if (diff) accumulateRange(st, diff.from, diff.to);

                    let forceFull = false;

                    // If a deletion caused the number of page nodes to drop, do a full rebuild.
                    if (isDeletion && nextPageCount < prevPageCount) {
                        forceFull = true;
                    }

                    // If the change window touches a page node in the OLD doc, be conservative.
                    if (!forceFull && diff && rangeTouchesPageNode(prevState.doc, diff.from, diff.to)) {
                        forceFull = true;
                    }

                    if (forceFull) {
                        st.pendingFrom = 0;
                        st.pendingTo = prevState.doc.content.size; // pass a whole-doc window to buildPageView
                    }
                    // ---- END NEW ----

                    // Accumulate changed range (in OLD doc positions)
                    const range = findChangedRangeInOldDoc(prevState, state);
                    if (range) accumulateRange(st, range.from, range.to);

                    // Remote Yjs storms batching
                    const ystate = ySyncPluginKey.getState(state) as { isChangeOrigin?: boolean } | undefined;
                    const isRemote = Boolean(ystate?.isChangeOrigin);
                    if (isRemote) {
                        st.remoteBatchCount = Math.min(st.remoteBatchCount + 1, MAX_REMOTE_BATCHES);
                    } else {
                        st.remoteBatchCount = 0;
                    }

                    // If already paginating or queued, just ensure a trailing run is scheduled.
                    if (st.isPaginating || st.queued) {
                        schedulePagination(v, runPagination);
                        return;
                    }

                    schedulePagination(v, runPagination);

                    function runPagination() {
                        if (st.isPaginating) return;
                        st.isPaginating = true;

                        try {
                            // Pass incremental window (if any). The incremental build will reuse head pages.
                            const from = st.pendingFrom;
                            const to = st.pendingTo;
                            //@ts-ignore
                            buildPageView(editor, v, options, from, to);

                            // reset window after successful run
                            st.pendingFrom = null;
                            st.pendingTo = null;
                        } catch (err) {
                            if (process.env.NODE_ENV !== "production") {
                                // eslint-disable-next-line no-console
                                console.error("[pagination] buildPageView error:", err);
                            }
                        } finally {
                            st.isPaginating = false;
                        }
                    }
                },

                destroy() {
                    const st = key.getState(view.state);
                    view.dom.removeEventListener("compositionstart", onCompositionStart);
                    view.dom.removeEventListener("compositionend", onCompositionEnd);
                    if (st?.throttleTimer != null) clearTimeout(st.throttleTimer);
                    if (st?.idleCancel) {
                        st.idleCancel();
                        st.idleCancel = null;
                    }
                },
            };
        },
    });

export default PaginationPlugin;
