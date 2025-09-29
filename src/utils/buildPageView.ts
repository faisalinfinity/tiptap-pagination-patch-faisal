/**
 * @file /src/utils/buildPageView.ts
 * @name BuildPageView
 * @description Utility functions for building the page view with Final Draft-compliant widow/orphan control.
 */

import { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { Editor } from "@tiptap/core";
import { PaginationOptions } from "../PaginationExtension";
import { MIN_PARAGRAPH_HEIGHT } from "../constants/pagination";
import { NodePosArray, NodePos } from "../types/node";
import { CursorMap } from "../types/cursor";
import { Nullable } from "../types/record";
import { MarginConfig } from "../types/page";
import {
  moveToNearestValidCursorPosition,
  moveToThisTextBlock,
  setSelection,
  setSelectionAtEndOfDocument
} from "./selection";
import { inRange } from "./math";
import { getPaginationNodeAttributes } from "./nodes/page/attributes/getPageAttributes";
import { isParagraphNode } from "./nodes/paragraph";
import { isTextNode } from "./nodes/text";
import { getPaginationNodeTypes } from "./pagination";
import { isPageNumInRange } from "./nodes/page/pageRange";
import { HeaderFooter, HeaderFooterNodeAttributes } from "../types/pageRegions";
import { getPageRegionNode } from "./pageRegion/getAttributes";
import { getMaybeNodeSize } from "./nodes/node";
import { isPageNode } from "./nodes/page/page";
import { isHeaderFooterNode } from "./nodes/headerFooter/headerFooter";
import { isBodyNode } from "./nodes/body/body";

/**
 * Content group for widow/orphan protection
 */
interface ContentGroup {
  items: NodePos[];
  totalHeight: number;
  mustStayTogether: boolean;
  groupType: string | null;
}

/**
 * Builds a new document with paginated content.
 *
 * @param view - The editor view.
 * @param options - The pagination options.
 * @returns {void}
 */
export const buildPageView = (editor: Editor, view: EditorView, options: PaginationOptions): void => {
  const { state, dispatch } = view;
  const { doc } = state;

  try {
    const contentNodes = collectContentNodes(doc);
    const nodeHeights = measureNodeHeights(view, contentNodes);

    // Record the cursor's old position
    const { tr, selection } = state;
    const oldCursorPos = selection.from;

    const { newDoc, oldToNewPosMap } = buildNewDocument(editor, options, contentNodes, nodeHeights);

    // Compare the content of the documents
    if (!newDoc.content.eq(doc.content)) {
      tr.replaceWith(0, doc.content.size, newDoc.content);
      tr.setMeta("pagination", true);

      const newDocContentSize = newDoc.content.size;
      const newCursorPos = mapCursorPosition(contentNodes, oldCursorPos, oldToNewPosMap, newDocContentSize);

      paginationUpdateCursorPosition(tr, newCursorPos);
    }

    dispatch(tr);
  } catch (error) {
    console.error("Error updating page view. Details:", error);
  }
};

/**
 * Collect content nodes and their existing positions.
 *
 * @param doc - The document node.
 * @returns {NodePosArray} The content nodes and their positions.
 */
const collectContentNodes = (doc: PMNode): NodePosArray => {
  const contentNodes: NodePosArray = [];

  doc.forEach((pageNode, pageOffset) => {
    if (isPageNode(pageNode)) {
      pageNode.forEach((pageRegionNode, pageRegionOffset) => {
        // Offsets in forEach loop start from 0, however, the child nodes of any given node
        // have a starting offset of 1 (for the first child)
        const truePageRegionOffset = pageRegionOffset + 1;

        if (isHeaderFooterNode(pageRegionNode)) {
          // Don't collect header/footer nodes
        } else if (isBodyNode(pageRegionNode)) {
          pageRegionNode.forEach((child, childOffset) => {
            // First child of body node (e.g. paragraph) has an offset of 1 more
            // than the body node itself.
            const trueChildOffset = childOffset + 1;
            contentNodes.push({
              node: child,
              pos: pageOffset + truePageRegionOffset + trueChildOffset
            });
          });
        } else {
          contentNodes.push({
            node: pageRegionNode,
            pos: pageOffset + truePageRegionOffset
          });
        }
      });
    } else {
      contentNodes.push({ node: pageNode, pos: pageOffset + 1 });
    }
  });

  return contentNodes;
};

/**
 * Calculates the margins of the element.
 *
 * @param element - The element to calculate margins for.
 * @returns {MarginConfig} The margins of the element.
 */
const calculateElementMargins = (element: HTMLElement): MarginConfig => {
  const style = window.getComputedStyle(element);
  return {
    top: parseFloat(style.marginTop),
    right: parseFloat(style.marginRight),
    bottom: parseFloat(style.marginBottom),
    left: parseFloat(style.marginLeft),
  };
};

/**
 * Measure the heights of the content nodes.
 *
 * @param view - The editor view.
 * @param contentNodes - The content nodes and their positions.
 * @returns {number[]} The heights of the content nodes.
 */
const measureNodeHeights = (view: EditorView, contentNodes: NodePosArray): number[] => {
  const paragraphType = view.state.schema.nodes.paragraph;

  const nodeHeights = contentNodes.map(({ pos, node }) => {
    const domNode = view.nodeDOM(pos);

    if (domNode instanceof HTMLElement) {
      let { height } = domNode.getBoundingClientRect();
      const { top: marginTop } = calculateElementMargins(domNode);

      if (height === 0) {
        if (node.type === paragraphType || node.isTextblock) {
          // Assign a minimum height to empty paragraphs or textblocks
          height = MIN_PARAGRAPH_HEIGHT;
        }
      }

      // We use top margin only because there is overlap of margins between paragraphs
      return height + marginTop;
    }

    return MIN_PARAGRAPH_HEIGHT; // Default to minimum height if DOM element is not found
  });

  return nodeHeights;
};

/**
 * Get the class type of a node
 */
const getNodeClass = (node: PMNode): string | null => {
  return node.attrs?.class || null;
};

/**
 * Create content groups for Final Draft widow/orphan rules
 */
const createContentGroups = (contentNodes: NodePosArray, nodeHeights: number[]): ContentGroup[] => {
  const groups: ContentGroup[] = [];
  let i = 0;

  while (i < contentNodes.length) {
    const curr = contentNodes[i];
    const currClass = getNodeClass(curr.node);
    
    // Scene heading + first action line
    if (currClass === "scene") {
      const group: ContentGroup = {
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: true,
        groupType: "scene"
      };
      i++;

      // Try to include first action line
      if (i < contentNodes.length) {
        const next = contentNodes[i];
        const nextClass = getNodeClass(next.node);
        if (!nextClass || nextClass === "action") {
          group.items.push(next);
          group.totalHeight += nodeHeights[i];
          i++;
        }
      }
      
      groups.push(group);
    }
    // Character + (Parenthetical) + Dialogue grouping
    else if (currClass === "character") {
      const group: ContentGroup = {
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: true,
        groupType: "character-dialogue"
      };
      i++;

      // Check for parenthetical
      if (i < contentNodes.length) {
        const next = contentNodes[i];
        const nextClass = getNodeClass(next.node);
        
        if (nextClass === "parenthetical") {
          group.items.push(next);
          group.totalHeight += nodeHeights[i];
          i++;
          
          // Must be followed by dialogue
          if (i < contentNodes.length && getNodeClass(contentNodes[i].node) === "dialogue") {
            group.items.push(contentNodes[i]);
            group.totalHeight += nodeHeights[i];
            i++;
          }
        } else if (nextClass === "dialogue") {
          group.items.push(next);
          group.totalHeight += nodeHeights[i];
          i++;
        }
      }
      
      groups.push(group);
    }
    // Default: single node groups
    else {
      groups.push({
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: false,
        groupType: currClass
      });
      i++;
    }
  }

  return groups;
};

/**
 * Build the new document and keep track of new positions.
 *
 * @param editor - The editor instance.
 * @param options - The pagination options.
 * @param contentNodes - The content nodes and their positions.
 * @param nodeHeights - The heights of the content nodes.
 * @returns {newDoc: PMNode, oldToNewPosMap: CursorMap} The new document and the mapping from old positions to new positions.
 */
const buildNewDocument = (
  editor: Editor,
  options: PaginationOptions,
  contentNodes: NodePosArray,
  nodeHeights: number[]
): { newDoc: PMNode; oldToNewPosMap: CursorMap } => {
  const { schema, doc } = editor.state;
  const { pageAmendmentOptions } = options;
  const {
    pageNodeType: pageType,
    headerFooterNodeType: headerFooterType,
    bodyNodeType: bodyType,
    paragraphNodeType: paragraphType,
  } = getPaginationNodeTypes(schema);

  let pageNum = 0;
  const pages: PMNode[] = [];
  let existingPageNode: Nullable<PMNode> = doc.maybeChild(pageNum);
  let { pageNodeAttributes, pageRegionNodeAttributes, bodyPixelDimensions } = getPaginationNodeAttributes(editor, pageNum);

  const constructHeaderFooter = <HF extends HeaderFooter>(pageRegionType: HeaderFooter) => (
    headerFooterAttrs: HeaderFooterNodeAttributes<HF>
  ): PMNode | undefined => {
    if (!headerFooterType) return;
    if (existingPageNode) {
      const hfNode = getPageRegionNode(existingPageNode, pageRegionType);
      if (hfNode) return hfNode;
    }
    return headerFooterType.create(headerFooterAttrs, [paragraphType.create()]);
  };

  const constructHeader = <HF extends HeaderFooter>(headerFooterAttrs: HeaderFooterNodeAttributes<HF>) =>
    pageAmendmentOptions.enableHeader ? constructHeaderFooter("header")(headerFooterAttrs) : undefined;

  const constructFooter = <HF extends HeaderFooter>(headerFooterAttrs: HeaderFooterNodeAttributes<HF>) =>
    pageAmendmentOptions.enableFooter ? constructHeaderFooter("footer")(headerFooterAttrs) : undefined;

  const constructPageRegions = (currentPageContent: PMNode[]): PMNode[] => {
    const { body: bodyAttrs, footer: footerAttrs } = pageRegionNodeAttributes;
    const pageBody = bodyType.create(bodyAttrs, currentPageContent);
    const pageFooter = constructFooter(footerAttrs);
    const regions = [currentPageHeader, pageBody, pageFooter].filter(Boolean) as PMNode[];
    return regions;
  };

  const addPage = (currentPageContent: PMNode[]): PMNode => {
    const pageNodeContents = constructPageRegions(currentPageContent);
    const pageNode = pageType.create(pageNodeAttributes, pageNodeContents);
    pages.push(pageNode);
    return pageNode;
  };

  let currentPageHeader: PMNode | undefined = constructHeader(pageRegionNodeAttributes.header);
  let currentPageContent: PMNode[] = [];
  let currentHeight = 0;
  const oldToNewPosMap: CursorMap = new Map();
  const pageOffset = 1;
  const bodyOffset = 1;
  let cumulativeNewDocPos = pageOffset + getMaybeNodeSize(currentPageHeader) + bodyOffset;

  // Create content groups with Final Draft rules
  const contentGroups = createContentGroups(contentNodes, nodeHeights);

  // Process each content group
  for (let g = 0; g < contentGroups.length; g++) {
    const group = contentGroups[g];
    const nextGroup = contentGroups[g + 1];
    
    // Calculate if this group fits on current page
    const remainingHeight = bodyPixelDimensions.bodyHeight - currentHeight;
    const groupFits = group.totalHeight <= remainingHeight;
    
    // Determine if we need a page break
    let needPageBreak = false;
    
    if (!groupFits && currentPageContent.length > 0) {
      needPageBreak = true;
    }
    
    // Special handling for scene headings - check if there's room for next content too
    if (group.groupType === "scene" && groupFits && nextGroup) {
      // Need at least 2 lines of space after scene heading
      const minSpaceNeeded = group.totalHeight + (MIN_PARAGRAPH_HEIGHT * 2);
      if (minSpaceNeeded > remainingHeight && currentPageContent.length > 0) {
        needPageBreak = true;
      }
    }
    
    // Special handling for character/dialogue - ensure minimum dialogue space
    if (group.groupType === "character-dialogue" && groupFits) {
      // If character name fits but not enough room for meaningful dialogue
      const minDialogueSpace = group.totalHeight + MIN_PARAGRAPH_HEIGHT;
      if (minDialogueSpace > remainingHeight && currentPageContent.length > 0) {
        needPageBreak = true;
      }
    }
    
    // Handle groups that must stay together
    if (group.mustStayTogether && !groupFits && currentPageContent.length > 0) {
      needPageBreak = true;
    }
    
    // Create new page if needed
    if (needPageBreak) {
      const pageNode = addPage(currentPageContent);
      cumulativeNewDocPos += pageNode.nodeSize - getMaybeNodeSize(currentPageHeader);
      currentPageContent = [];
      currentHeight = 0;
      
      existingPageNode = doc.maybeChild(++pageNum);
      if (isPageNumInRange(doc, pageNum)) {
        ({ pageNodeAttributes, pageRegionNodeAttributes, bodyPixelDimensions } = getPaginationNodeAttributes(editor, pageNum));
      }
      
      currentPageHeader = constructHeader(pageRegionNodeAttributes.header);
      cumulativeNewDocPos += getMaybeNodeSize(currentPageHeader);
    }
    
    // Add all items in the group to current page
    for (const item of group.items) {
      const { node, pos: oldPos } = item;
      const offsetInPage = currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
      const nodeStartPosInNewDoc = cumulativeNewDocPos + offsetInPage;
      
      oldToNewPosMap.set(oldPos, nodeStartPosInNewDoc);
      currentPageContent.push(node);
    }
    
    currentHeight += group.totalHeight;
  }

  // Add any remaining content to the last page
  if (currentPageContent.length > 0) {
    addPage(currentPageContent);
  }

  const newDoc = schema.topNodeType.create(null, pages);
  limitMappedCursorPositions(oldToNewPosMap, newDoc.content.size);

  return { newDoc, oldToNewPosMap };
};

/**
 * Limit mapped cursor positions to document size to prevent out of bounds errors
 * when setting the cursor position.
 *
 * @param oldToNewPosMap - The mapping from old positions to new positions.
 * @param docSize - The size of the new document.
 * @returns {void}
 */
const limitMappedCursorPositions = (oldToNewPosMap: CursorMap, docSize: number): void => {
  oldToNewPosMap.forEach((newPos, oldPos) => {
    if (newPos > docSize) {
      oldToNewPosMap.set(oldPos, docSize);
    }
  });
};

/**
 * Map the cursor position from the old document to the new document.
 *
 * @param contentNodes - The content nodes and their positions.
 * @param oldCursorPos - The old cursor position.
 * @param oldToNewPosMap - The mapping from old positions to new positions.
 * @param newDocContentSize - The size of the new document. Serves as maximum limit for cursor position.
 * @returns {number} The new cursor position.
 */
const mapCursorPosition = (
  contentNodes: NodePosArray,
  oldCursorPos: number,
  oldToNewPosMap: CursorMap,
  newDocContentSize: number
): Nullable<number> => {
  let newCursorPos: Nullable<number> = null;

  for (let i = 0; i < contentNodes.length; i++) {
    const { node, pos: oldNodePos } = contentNodes[i];
    const nodeSize = node.nodeSize;

    if (inRange(oldCursorPos, oldNodePos, oldNodePos + nodeSize)) {
      const offsetInNode = oldCursorPos - oldNodePos;
      const newNodePos = oldToNewPosMap.get(oldNodePos);

      if (newNodePos === undefined) {
        console.error("Unable to determine new node position from cursor map!");
        newCursorPos = 0;
      } else {
        newCursorPos = Math.min(newNodePos + offsetInNode, newDocContentSize - 1);
      }
      break;
    }
  }

  return newCursorPos;
};

/**
 * Check if the given position is at the start of a text block.
 *
 * @param doc - The document node.
 * @param $pos - The resolved position in the document.
 * @returns {boolean} True if the position is at the start of a text block, false otherwise.
 */
const isNodeBeforeAvailable = ($pos: ResolvedPos): boolean => {
  return !!$pos.nodeBefore && (isTextNode($pos.nodeBefore) || isParagraphNode($pos.nodeBefore));
};

/**
 * Check if the given position is at the end of a text block.
 *
 * @param doc - The document node.
 * @param $pos - The resolved position in the document.
 * @returns {boolean} True if the position is at the end of a text block, false otherwise.
 */
const isNodeAfterAvailable = ($pos: ResolvedPos): boolean => {
  return !!$pos.nodeAfter && (isTextNode($pos.nodeAfter) || isParagraphNode($pos.nodeAfter));
};

/**
 * Sets the cursor selection after creating the new document.
 *
 * @param tr - The current transaction.
 * @returns {void}
 */
const paginationUpdateCursorPosition = (tr: Transaction, newCursorPos: Nullable<number>): void => {
  if (newCursorPos !== null) {
    const $pos = tr.doc.resolve(newCursorPos);
    let selection;

    if ($pos.parent.isTextblock || isNodeBeforeAvailable($pos) || isNodeAfterAvailable($pos)) {
      selection = moveToThisTextBlock(tr, $pos);
    } else {
      selection = moveToNearestValidCursorPosition($pos);
    }

    if (selection) {
      setSelection(tr, selection);
    } else {
      // Fallback to a safe selection at the end of the document
      setSelectionAtEndOfDocument(tr);
    }
  } else {
    setSelectionAtEndOfDocument(tr);
  }
};       

