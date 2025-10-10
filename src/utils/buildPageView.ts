/**
 * @file /src/utils/buildPageView.ts
 * @name BuildPageView
 * @description Utility functions for building the page view with Final Draft-compliant widow/orphan control and smart content splitting.
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
// import { MarginConfig } from "../types/page";
import {
  moveToNearestValidCursorPosition,
  moveToThisTextBlock,
  setSelection,
  setSelectionAtEndOfDocument
} from "./selection";
// import { inRange } from "./math";
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
  allowSplit?: boolean; // Unified flag for dialogue/action splitting
}

/**
 * Split result for a node that needs to be split across pages
 */
interface SplitResult {
  firstPart: PMNode;
  secondPart: PMNode;
  firstPartHeight: number;
  secondPartHeight: number;
  splitItemIndex: number; // Index of the item that was split within the group
}

/**
 * Cache for expensive calculations
 */
interface CalculationCache {
  textContent: WeakMap<PMNode, string>;
  sentences: Map<string, string[]>;
  nodeClasses: WeakMap<PMNode, string | null>;
}

/**
 * Constants for Final Draft-compliant pagination
 */
const MIN_LINES_ON_PAGE = 2;
const MIN_LINES_AFTER_SPLIT = 2;
const ESTIMATED_LINE_HEIGHT = MIN_PARAGRAPH_HEIGHT;

// Global cache instance to persist across calls
const globalCache: CalculationCache = {
  textContent: new WeakMap(),
  sentences: new Map(),
  nodeClasses: new WeakMap()
};

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
    const startTime = performance.now();
    
    const contentNodes = collectContentNodes(doc);
    const nodeHeights = measureNodeHeightsBatched(view, contentNodes);

    // Record the cursor's old position
    const { tr, selection } = state;
    const oldCursorPos = selection.from;

    const { newDoc, oldToNewPosMap } = buildNewDocument(
      editor, 
      view, 
      options, 
      contentNodes, 
      nodeHeights,
      globalCache
    );

    // Compare the content of the documents
    if (!newDoc.content.eq(doc.content)) {
      tr.replaceWith(0, doc.content.size, newDoc.content);
      tr.setMeta("pagination", true);

      const newDocContentSize = newDoc.content.size;
      const newCursorPos = mapCursorPosition(contentNodes, oldCursorPos, oldToNewPosMap, newDocContentSize);

      paginationUpdateCursorPosition(tr, newCursorPos);
    }

    dispatch(tr);
    
    const endTime = performance.now();
    if (endTime - startTime > 100) {
      console.debug(`Pagination took ${endTime - startTime}ms`);
    }
  } catch (error) {
    console.error("Error updating page view. Details:", error);
  }
};

/**
 * Collect content nodes and their existing positions with optimized traversal.
 *
 * @param doc - The document node.
 * @returns {NodePosArray} The content nodes and their positions.
 */
const collectContentNodes = (doc: PMNode): NodePosArray => {
  const contentNodes: NodePosArray = [];

  doc.forEach((pageNode, pageOffset) => {
    if (isPageNode(pageNode)) {
      pageNode.forEach((pageRegionNode, pageRegionOffset) => {
        const truePageRegionOffset = pageRegionOffset + 1;

        if (isHeaderFooterNode(pageRegionNode)) {
          // Don't collect header/footer nodes
        } else if (isBodyNode(pageRegionNode)) {
          pageRegionNode.forEach((child, childOffset) => {
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
 * Measure the heights of the content nodes in batches for performance.
 *
 * @param view - The editor view.
 * @param contentNodes - The content nodes and their positions.
 * @returns {number[]} The heights of the content nodes.
 */
const measureNodeHeightsBatched = (view: EditorView, contentNodes: NodePosArray): number[] => {
  const paragraphType = view.state.schema.nodes.paragraph;
  const nodeHeights: number[] = new Array(contentNodes.length);
  
  // Batch collect DOM nodes
  const domNodes: Array<HTMLElement | null> = [];
  for (let i = 0; i < contentNodes.length; i++) {
    const domNode = view.nodeDOM(contentNodes[i].pos);
    domNodes.push(domNode instanceof HTMLElement ? domNode : null);
  }

  // Force a single reflow/layout calculation
  if (domNodes.length > 0 && domNodes[0]) {
    void domNodes[0].offsetHeight;
  }

  // Now read all heights in batch
  for (let i = 0; i < domNodes.length; i++) {
    const domNode = domNodes[i];
    const node = contentNodes[i].node;
    let height = MIN_PARAGRAPH_HEIGHT;

    if (domNode) {
      const rect = domNode.getBoundingClientRect();
      height = rect.height || MIN_PARAGRAPH_HEIGHT;
      
      if (height === 0 && (node.type === paragraphType || node.isTextblock)) {
        height = MIN_PARAGRAPH_HEIGHT;
      }

      // Add margin top
      const style = window.getComputedStyle(domNode);
      const marginTop = parseFloat(style.marginTop) || 0;
      height += marginTop;
    }

    nodeHeights[i] = height;
  }

  return nodeHeights;
};

/**
 * Get the class type of a node with caching
 */
const getNodeClass = (node: PMNode, cache: CalculationCache): string | null => {
  if (cache.nodeClasses.has(node)) {
    return cache.nodeClasses.get(node)!;
  }
  const nodeClass = node.attrs?.class || null;
  cache.nodeClasses.set(node, nodeClass);
  return nodeClass;
};

/**
 * Extract text content from a node with caching
 */
const extractTextContent = (node: PMNode, cache: CalculationCache): string => {
  if (cache.textContent.has(node)) {
    return cache.textContent.get(node)!;
  }

  let text = "";
  node.descendants((child) => {
    if (child.isText) {
      text += child.text;
    }
  });

  cache.textContent.set(node, text);
  return text;
};

/**
 * Split text content at sentence boundaries with caching
 */
const splitIntoSentences = (text: string, cache: CalculationCache): string[] => {
  if (cache.sentences.has(text)) {
    return cache.sentences.get(text)!;
  }

  if (!text || !text.trim()) {
    cache.sentences.set(text, []);
    return [];
  }
  
  const sentences: string[] = [];
  const parts = text.split(/(\.[^\w]|\.$)/);
  
  let currentSentence = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.match(/\.[^\w]/) || part === ".") {
      currentSentence += part;
      if (currentSentence.trim()) {
        sentences.push(currentSentence.trim());
      }
      currentSentence = "";
    } else {
      currentSentence += part;
    }
  }
  
  if (currentSentence.trim()) {
    sentences.push(currentSentence.trim());
  }

  const result = sentences.filter(s => s.length > 0);
  cache.sentences.set(text, result);
  return result;
};

/**
 * Estimate height of text content based on character count
 */
const estimateTextHeight = (text: string, nodeHeight: number, originalText: string): number => {
  if (originalText.length === 0) return MIN_PARAGRAPH_HEIGHT;
  const ratio = text.length / originalText.length;
  return Math.max(nodeHeight * ratio, MIN_PARAGRAPH_HEIGHT);
};

/**
 * Check if a node can be split (dialogue or action)
 */
const isSplittableNode = (node: PMNode, cache: CalculationCache): boolean => {
  const nodeClass = getNodeClass(node, cache);
  return nodeClass === "dialogue" || nodeClass === "action" || !nodeClass;
};

/**
 * Try to split a node at sentence boundaries with optimized search
 */
const trySplitNode = (
  node: PMNode,
  nodeHeight: number,
  availableHeight: number,
  view: EditorView,
  cache: CalculationCache
): SplitResult | null => {
  if (!isSplittableNode(node, cache)) {
    return null;
  }

  const text = extractTextContent(node, cache);
  if (!text.trim()) {
    return null;
  }

  const sentences = splitIntoSentences(text, cache);
  if (sentences.length < 2) {
    return null;
  }

  const minHeightForFirstPart = MIN_LINES_AFTER_SPLIT * ESTIMATED_LINE_HEIGHT;
  const minHeightForSecondPart = MIN_LINES_AFTER_SPLIT * ESTIMATED_LINE_HEIGHT;

  // Binary search for optimal split point
  let left = 0;
  let right = sentences.length - 2;
  let bestSplitIndex = -1;
  let bestFirstPartText = "";

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const firstPartText = sentences.slice(0, mid + 1).join(" ");
    const secondPartText = sentences.slice(mid + 1).join(" ");
    
    const estimatedHeight = estimateTextHeight(firstPartText, nodeHeight, text);
    const secondPartHeight = estimateTextHeight(secondPartText, nodeHeight, text);

    if (
      estimatedHeight >= minHeightForFirstPart &&
      estimatedHeight <= availableHeight &&
      secondPartHeight >= minHeightForSecondPart
    ) {
      bestSplitIndex = mid;
      bestFirstPartText = firstPartText;
      left = mid + 1; // Try to find a better split that uses more space
    } else if (estimatedHeight > availableHeight) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  if (bestSplitIndex < 0) {
    return null;
  }

  const secondPartText = sentences.slice(bestSplitIndex + 1).join(" ");
  // const nodeClass = getNodeClass(node, cache);
  const schema = view.state.schema;

  const firstPartNode = createNodeWithText(node, bestFirstPartText.trim(), schema);
  const secondPartNode = createNodeWithText(node, secondPartText.trim(), schema);

  const firstPartHeight = estimateTextHeight(bestFirstPartText, nodeHeight, text);
  const secondPartHeight = estimateTextHeight(secondPartText, nodeHeight, text);

  return {
    firstPart: firstPartNode,
    secondPart: secondPartNode,
    firstPartHeight,
    secondPartHeight,
    splitItemIndex: 0
  };
};

/**
 * Create a node with text content, preserving node type and attributes
 */
const createNodeWithText = (
  originalNode: PMNode,
  text: string,
  schema: any,
  // nodeClass: string | null,
  // isContinuation: boolean
): PMNode => {
  const textNode = schema.text(text);
  const attrs = { ...originalNode.attrs };
  return originalNode.type.create(attrs, textNode);
};

/**
 * Try to split a group that contains dialogue or action
 */
const tryGroupSplit = (
  group: ContentGroup,
  groupHeights: number[],
  availableHeight: number,
  view: EditorView,
  cache: CalculationCache
): SplitResult | null => {
  if (!group.allowSplit) {
    return null;
  }

  // Find splittable items (dialogue or action)
  for (let i = 0; i < group.items.length; i++) {
    const item = group.items[i];
    const nodeClass = getNodeClass(item.node, cache);
    
    if ((nodeClass === "dialogue" || nodeClass === "action") && isSplittableNode(item.node, cache)) {
      const heightBeforeItem = groupHeights.slice(0, i).reduce((sum, h) => sum + h, 0);
      const remainingHeight = availableHeight - heightBeforeItem;
      
      if (remainingHeight > MIN_LINES_AFTER_SPLIT * ESTIMATED_LINE_HEIGHT) {
        const splitResult = trySplitNode(item.node, groupHeights[i], remainingHeight, view, cache);
        if (splitResult) {
          return {
            ...splitResult,
            splitItemIndex: i
          };
        }
      }
    }
  }
  
  return null;
};

/**
 * Create content groups for Final Draft widow/orphan rules with action splitting
 */
const createContentGroups = (contentNodes: NodePosArray, nodeHeights: number[], cache: CalculationCache): ContentGroup[] => {
  const groups: ContentGroup[] = [];
  let i = 0;

  while (i < contentNodes.length) {
    const curr = contentNodes[i];
    const currClass = getNodeClass(curr.node, cache);
    
    // Scene heading + first action line
    if (currClass === "scene") {
      const group: ContentGroup = {
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: true,
        groupType: "scene",
        allowSplit: false
      };
      i++;

      // Try to include first action line
      if (i < contentNodes.length) {
        const next = contentNodes[i];
        const nextClass = getNodeClass(next.node, cache);
        if (!nextClass || nextClass === "action") {
          group.items.push(next);
          group.totalHeight += nodeHeights[i];
          // Allow split if it's an action node
          group.allowSplit = nextClass === "action";
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
        groupType: "character-dialogue",
        allowSplit: true // Allow dialogue within this group to be split
      };
      i++;

      // Check for parenthetical
      if (i < contentNodes.length) {
        const next = contentNodes[i];
        const nextClass = getNodeClass(next.node, cache);
        
        if (nextClass === "parenthetical") {
          group.items.push(next);
          group.totalHeight += nodeHeights[i];
          i++;
          
          // Must be followed by dialogue
          if (i < contentNodes.length && getNodeClass(contentNodes[i].node, cache) === "dialogue") {
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
    // Standalone action nodes (can be split)
    else if (currClass === "action") {
      groups.push({
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: false,
        groupType: "action",
        allowSplit: true
      });
      i++;
    }
    // Default: single node groups
    else {
      groups.push({
        items: [curr],
        totalHeight: nodeHeights[i],
        mustStayTogether: false,
        groupType: currClass,
        allowSplit: isSplittableNode(curr.node, cache)
      });
      i++;
    }
  }

  return groups;
};

/**
 * Build the new document and keep track of new positions with optimization.
 */
const buildNewDocument = (
  editor: Editor,
  view: EditorView,
  options: PaginationOptions,
  contentNodes: NodePosArray,
  nodeHeights: number[],
  cache: CalculationCache
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
  const contentGroups = createContentGroups(contentNodes, nodeHeights, cache);

  // Process each content group
  for (let g = 0; g < contentGroups.length; g++) {
    const group = contentGroups[g];
    const nextGroup = contentGroups[g + 1];
    
    // Calculate if this group fits on current page
    const remainingHeight = bodyPixelDimensions.bodyHeight - currentHeight;
    const groupFits = group.totalHeight <= remainingHeight;
    
    // Determine if we need a page break or can split
    let needPageBreak = false;
    let splitResult: SplitResult | null = null;
    
    // Check if we should try to split the group
    if (!groupFits && group.allowSplit && remainingHeight > MIN_PARAGRAPH_HEIGHT) {
      // Create height array for this group
      const groupHeights: number[] = [];
      let startIndex = -1;
      
      // Find the starting index of this group in the nodeHeights array
      for (let nodeIndex = 0; nodeIndex < contentNodes.length; nodeIndex++) {
        if (contentNodes[nodeIndex].pos === group.items[0].pos) {
          startIndex = nodeIndex;
          break;
        }
      }
      
      if (startIndex >= 0) {
        for (let i = 0; i < group.items.length; i++) {
          groupHeights.push(nodeHeights[startIndex + i]);
        }
        
        splitResult = tryGroupSplit(group, groupHeights, remainingHeight, view, cache);
      }
    }
    
    // If we can't split and don't fit, force page break
    if (!groupFits && !splitResult && currentPageContent.length > 0) {
      needPageBreak = true;
    }
    
    // Special handling for scene headings - check if there's room for next content too
    if (group.groupType === "scene" && groupFits && nextGroup) {
      const minSpaceNeeded = group.totalHeight + (MIN_PARAGRAPH_HEIGHT * MIN_LINES_ON_PAGE);
      if (minSpaceNeeded > remainingHeight && currentPageContent.length > 0) {
        needPageBreak = true;
      }
    }
    
    // Special handling for character/dialogue - ensure minimum dialogue space
    if (group.groupType === "character-dialogue" && groupFits && !splitResult) {
      const minDialogueSpace = group.totalHeight + MIN_PARAGRAPH_HEIGHT;
      if (minDialogueSpace > remainingHeight && currentPageContent.length > 0) {
        needPageBreak = true;
      }
    }
    
    // Handle groups that must stay together
    if (group.mustStayTogether && !groupFits && !splitResult && currentPageContent.length > 0) {
      needPageBreak = true;
    }
    
    // Process split result if we have one
    if (splitResult) {
      // Add items before the split item to current page
      for (let i = 0; i < splitResult.splitItemIndex; i++) {
        const item = group.items[i];
        const offsetInPage = currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
        const nodeStartPosInNewDoc = cumulativeNewDocPos + offsetInPage;
        
        oldToNewPosMap.set(item.pos, nodeStartPosInNewDoc);
        currentPageContent.push(item.node);
      }
      
      // Add first part of split item to current page
      const splitItem = group.items[splitResult.splitItemIndex];
      const offsetInPage = currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
      const nodeStartPosInNewDoc = cumulativeNewDocPos + offsetInPage;
      
      oldToNewPosMap.set(splitItem.pos, nodeStartPosInNewDoc);
      currentPageContent.push(splitResult.firstPart);
      
      // Force page break
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
      
      // Add continuation content if we have a split
      if (splitResult) {
        // Add second part of split item to new page
        currentPageContent.push(splitResult.secondPart);
        currentHeight += splitResult.secondPartHeight;
        
        // Add remaining items after the split
        for (let i = splitResult.splitItemIndex + 1; i < group.items.length; i++) {
          const item = group.items[i];
          const offsetInPage = currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
          const nodeStartPosInNewDoc = cumulativeNewDocPos + offsetInPage;
          
          oldToNewPosMap.set(item.pos, nodeStartPosInNewDoc);
          currentPageContent.push(item.node);
        }
        
        // Clear split result and continue
        splitResult = null;
        continue;
      }
    }
    
    // Add all items in the group to current page (if we didn't already handle via split)
    if (!splitResult) {
      for (const item of group.items) {
        const { node, pos: oldPos } = item;
        const offsetInPage = currentPageContent.reduce((sum, n) => sum + n.nodeSize, 0);
        const nodeStartPosInNewDoc = cumulativeNewDocPos + offsetInPage;
        
        oldToNewPosMap.set(oldPos, nodeStartPosInNewDoc);
        currentPageContent.push(node);
      }
      
      currentHeight += group.totalHeight;
    }
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
 */
const limitMappedCursorPositions = (oldToNewPosMap: CursorMap, docSize: number): void => {
  oldToNewPosMap.forEach((newPos, oldPos) => {
    if (newPos > docSize) {
      oldToNewPosMap.set(oldPos, docSize);
    }
  });
};

/**
 * Map the cursor position from the old document to the new document with binary search
 */
const mapCursorPosition = (
  contentNodes: NodePosArray,
  oldCursorPos: number,
  oldToNewPosMap: CursorMap,
  newDocContentSize: number
): Nullable<number> => {
  // Binary search for the node containing the cursor
  let left = 0;
  let right = contentNodes.length - 1;
  let foundNode: NodePos | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const { node, pos: oldNodePos } = contentNodes[mid];
    const nodeEndPos = oldNodePos + node.nodeSize;

    if (oldCursorPos >= oldNodePos && oldCursorPos <= nodeEndPos) {
      foundNode = contentNodes[mid];
      break;
    } else if (oldCursorPos < oldNodePos) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  if (foundNode) {
    const { pos: oldNodePos } = foundNode;
    const offsetInNode = oldCursorPos - oldNodePos;
    const newNodePos = oldToNewPosMap.get(oldNodePos);

    if (newNodePos !== undefined) {
      return Math.min(newNodePos + offsetInNode, newDocContentSize - 1);
    }
  }

  // Fallback: find closest mapped position
  let closestPos = 0;
  let minDistance = Infinity;

  oldToNewPosMap.forEach((newPos, oldPos) => {
    const distance = Math.abs(oldPos - oldCursorPos);
    if (distance < minDistance) {
      minDistance = distance;
      closestPos = newPos;
    }
  });

  return Math.min(closestPos, newDocContentSize - 1);
};

/**
 * Check if the given position is at the start of a text block.
 */
const isNodeBeforeAvailable = ($pos: ResolvedPos): boolean => {
  return !!$pos.nodeBefore && (isTextNode($pos.nodeBefore) || isParagraphNode($pos.nodeBefore));
};

/**
 * Check if the given position is at the end of a text block.
 */
const isNodeAfterAvailable = ($pos: ResolvedPos): boolean => {
  return !!$pos.nodeAfter && (isTextNode($pos.nodeAfter) || isParagraphNode($pos.nodeAfter));
};

/**
 * Sets the cursor selection after creating the new document.
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
      setSelectionAtEndOfDocument(tr);
    }
  } else {
    setSelectionAtEndOfDocument(tr);
  }
};