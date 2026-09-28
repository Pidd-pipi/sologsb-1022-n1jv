import type {
  Annotation,
  AnnotationKind,
  Chapter,
  ConflictGroup,
  EditorState,
  RestoreAnnotationEntry,
  RestorePlan,
  RestoreRegressedConflict,
  SearchResult,
  Sentence,
  TextDocument,
  VersionSnapshot,
  WorkspaceState
} from './types';
import { tokenizeText } from './data';

export const STORAGE_KEY = 'sologsb-1022/public-text-annotator/v1';

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInitialWorkspace(document: TextDocument): WorkspaceState {
  return {
    document: clone(document),
    mode: 'reading',
    selectedChapterId: document.chapters[0]?.id ?? '',
    selectedSentenceId: document.chapters[0]?.sentences[0]?.id ?? '',
    selectedAnnotationId: null,
    query: '',
    dirty: false
  };
}

export function createInitialEditorState(document: TextDocument): EditorState {
  return {
    workspace: createInitialWorkspace(document),
    past: [],
    future: [],
    lastAction: '已载入整理底本'
  };
}

function pushHistory(state: EditorState, next: WorkspaceState, label: string): EditorState {
  return {
    workspace: next,
    past: [...state.past.slice(-39), clone(state.workspace)],
    future: [],
    lastAction: label
  };
}

export type EditorAction =
  | { type: 'hydrate'; workspace: WorkspaceState }
  | { type: 'commit'; label: string; mutate: (document: TextDocument) => void }
  | { type: 'selectChapter'; chapterId: string }
  | { type: 'selectSentence'; chapterId: string; sentenceId: string }
  | { type: 'selectAnnotation'; annotationId: string | null }
  | { type: 'setMode'; mode: WorkspaceState['mode'] }
  | { type: 'setQuery'; query: string }
  | { type: 'undo' }
  | { type: 'redo' };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'hydrate':
      return {
        workspace: action.workspace,
        past: [],
        future: [],
        lastAction: '已恢复离线草稿'
      };
    case 'commit': {
      const next = clone(state.workspace);
      action.mutate(next.document);
      next.document.updatedAt = new Date().toISOString();
      next.dirty = true;
      return pushHistory(state, next, action.label);
    }
    case 'selectChapter': {
      const chapter = state.workspace.document.chapters.find((item) => item.id === action.chapterId);
      return {
        ...state,
        workspace: {
          ...state.workspace,
          selectedChapterId: action.chapterId,
          selectedSentenceId: chapter?.sentences[0]?.id ?? '',
          selectedAnnotationId: null
        }
      };
    }
    case 'selectSentence':
      return {
        ...state,
        workspace: {
          ...state.workspace,
          selectedChapterId: action.chapterId,
          selectedSentenceId: action.sentenceId,
          selectedAnnotationId: null
        }
      };
    case 'selectAnnotation':
      return {
        ...state,
        workspace: { ...state.workspace, selectedAnnotationId: action.annotationId }
      };
    case 'setMode':
      return { ...state, workspace: { ...state.workspace, mode: action.mode } };
    case 'setQuery':
      return { ...state, workspace: { ...state.workspace, query: action.query } };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        workspace: clone(previous),
        past: state.past.slice(0, -1),
        future: [clone(state.workspace), ...state.future].slice(0, 40),
        lastAction: '已撤销上一步操作'
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        workspace: clone(next),
        past: [...state.past, clone(state.workspace)].slice(-40),
        future: state.future.slice(1),
        lastAction: '已重做上一步操作'
      };
    }
    default:
      return state;
  }
}

export function getSentence(document: TextDocument, sentenceId: string): Sentence | undefined {
  for (const chapter of document.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (sentence) return sentence;
  }
  return undefined;
}

export function getTargetLabel(document: TextDocument, annotation: Annotation): string {
  if (annotation.anchorType === 'chapter') {
    return document.chapters.find((chapter) => chapter.id === annotation.anchorId)?.title ?? '未知章节';
  }

  for (const chapter of document.chapters) {
    if (annotation.anchorType === 'sentence') {
      const sentence = chapter.sentences.find((item) => item.id === annotation.anchorId);
      if (sentence) return `${chapter.title} · 第 ${sentence.order} 句`;
    } else {
      for (const sentence of chapter.sentences) {
        const token = sentence.tokens.find((item) => item.id === annotation.anchorId);
        if (token) return `${chapter.title} · “${token.text.trim()}”`;
      }
    }
  }

  return '引用目标已迁移到所属句';
}

export function collectSearchResults(document: TextDocument, query: string): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  const results: SearchResult[] = [];
  for (const chapter of document.chapters) {
    if (chapter.title.toLocaleLowerCase().includes(normalized)) {
      results.push({
        chapterId: chapter.id,
        title: chapter.title,
        excerpt: chapter.summary,
        kind: 'text'
      });
    }
    for (const sentence of chapter.sentences) {
      if (sentence.text.toLocaleLowerCase().includes(normalized)) {
        results.push({
          chapterId: chapter.id,
          sentenceId: sentence.id,
          title: `${chapter.title} · 第 ${sentence.order} 句`,
          excerpt: sentence.text,
          kind: 'text'
        });
      }
    }
  }

  for (const annotation of document.annotations) {
    const searchable = `${annotation.title} ${annotation.body} ${annotation.source}`.toLocaleLowerCase();
    if (searchable.includes(normalized)) {
      const sentence = getSentence(document, annotation.anchorType === 'sentence' ? annotation.anchorId : '');
      results.push({
        chapterId: findChapterIdForAnnotation(document, annotation),
        sentenceId: sentence?.id,
        annotationId: annotation.id,
        title: annotation.title,
        excerpt: `${annotation.source} · ${annotation.body}`,
        kind: 'annotation'
      });
    }
  }

  return results.slice(0, 24);
}

function findChapterIdForAnnotation(document: TextDocument, annotation: Annotation) {
  if (annotation.anchorType === 'chapter') return annotation.anchorId;
  for (const chapter of document.chapters) {
    if (chapter.sentences.some((sentence) => sentence.id === annotation.anchorId)) return chapter.id;
    if (
      annotation.anchorType === 'word' &&
      chapter.sentences.some((sentence) => sentence.tokens.some((token) => token.id === annotation.anchorId))
    ) {
      return chapter.id;
    }
  }
  return document.chapters[0]?.id ?? '';
}

export function getConflictGroups(document: TextDocument): ConflictGroup[] {
  const groups = new Map<string, Annotation[]>();
  for (const annotation of document.annotations) {
    if (annotation.conflictState === 'resolved') continue;
    const key = `${annotation.anchorId}:${annotation.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), annotation]);
  }

  return Array.from(groups.entries())
    .filter(([, items]) => {
      const bodies = new Set(items.map((item) => item.body.trim()));
      return bodies.size > 1;
    })
    .map(([key, items]) => {
      const first = items[0];
      const sentence = first.anchorType === 'sentence' ? getSentence(document, first.anchorId) : undefined;
      const tokenText = findTokenText(document, first.anchorId);
      return {
        key,
        anchorId: first.anchorId,
        anchorType: first.anchorType,
        kind: first.kind,
        anchorLabel: sentence ? `“${sentence.text}”` : tokenText ? `“${tokenText}”` : '文本片段',
        annotations: items
      };
    });
}

function findTokenText(document: TextDocument, tokenId: string) {
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      const token = sentence.tokens.find((item) => item.id === tokenId);
      if (token) return token.text.trim();
    }
  }
  return '';
}

export function kindLabel(kind: AnnotationKind) {
  return {
    footnote: '脚注',
    variant: '异文',
    background: '背景',
    crossref: '互见'
  }[kind];
}

export function updateSentenceText(
  document: TextDocument,
  sentenceId: string,
  text: string,
  tokenize: (value: string, id: string, existing: Sentence['tokens']) => Sentence['tokens']
) {
  let remappedAnnotations = 0;
  for (const chapter of document.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (!sentence) continue;
    const previousIds = new Set(sentence.tokens.map((token) => token.id));
    sentence.text = text;
    sentence.tokens = tokenize(text, sentence.id, sentence.tokens);
    const remainingIds = new Set(sentence.tokens.map((token) => token.id));

    for (const annotation of document.annotations) {
      if (annotation.anchorType === 'word' && previousIds.has(annotation.anchorId) && !remainingIds.has(annotation.anchorId)) {
        annotation.anchorId = sentence.id;
        annotation.anchorType = 'sentence';
        annotation.title = `${annotation.title}（引用已随修订迁移）`;
        remappedAnnotations += 1;
      }
    }
    break;
  }
  return remappedAnnotations;
}

export function removeAnnotationReferences(document: TextDocument, removedId: string) {
  for (const annotation of document.annotations) {
    annotation.references = annotation.references.filter((id) => id !== removedId);
  }
}

export function toWorkspace(document: TextDocument, fallback: WorkspaceState): WorkspaceState {
  const chapter = document.chapters.find((item) => item.id === fallback.selectedChapterId) ?? document.chapters[0];
  const sentence = chapter?.sentences.find((item) => item.id === fallback.selectedSentenceId) ?? chapter?.sentences[0];
  return {
    document,
    mode: fallback.mode,
    selectedChapterId: chapter?.id ?? '',
    selectedSentenceId: sentence?.id ?? '',
    selectedAnnotationId: fallback.selectedAnnotationId,
    query: fallback.query,
    dirty: false
  };
}

interface ChapterIndex {
  chapter: Chapter;
  sentenceById: Map<string, Sentence>;
}

function buildChapterIndex(chapters: Chapter[]): Map<string, ChapterIndex> {
  return new Map(
    chapters.map((chapter) => [
      chapter.id,
      { chapter, sentenceById: new Map(chapter.sentences.map((sentence) => [sentence.id, sentence])) }
    ])
  );
}

/**
 * 切词用的候选 token：当前正文优先，旧稿同文 token 补充在后，按文本去重。
 * 同文词语在旧稿与当前可能持有不同 ID：恢复旧稿文字时当前 ID 仍有效，
 * 旧稿 ID 则供旧稿正文中当前已不存在的词语复用。
 */
function mergeTokenPool(oldTokens: Sentence['tokens'], currentTokens: Sentence['tokens']): Sentence['tokens'] {
  const seenText = new Set<string>();
  const pool: Sentence['tokens'] = [];
  for (const token of [...currentTokens, ...oldTokens]) {
    if (seenText.has(token.text)) continue;
    seenText.add(token.text);
    pool.push(token);
  }
  return pool;
}

function annotationRevisionSignature(annotation: Annotation) {
  return JSON.stringify({
    anchorId: annotation.anchorId,
    anchorType: annotation.anchorType,
    kind: annotation.kind,
    title: annotation.title,
    body: annotation.body,
    source: annotation.source,
    references: annotation.references,
    tags: annotation.tags
  });
}

/**
 * 生成从旧快照恢复的合并计划，但不写入任何数据。
 * - 句子：并存句采用旧稿文字；快照后的新句保留；当前已删句随旧稿恢复。
 * - 注释：新注释与既有注释的当前修订保留；旧稿注释恢复。
 * - 词级引用：旧稿正文中词语已不存在时，迁移到所属句，避免悬空引用。
 * - 冲突闸门：旧快照已解决而当前又有新来源的冲突列入 regressedConflicts。
 */
export function planRestore(document: TextDocument, snapshotId: string): RestorePlan | null {
  const foundSnapshot = document.snapshots.find((item) => item.id === snapshotId);
  if (!foundSnapshot) return null;
  const snapshot: VersionSnapshot = foundSnapshot;

  const currentChapters = buildChapterIndex(document.chapters);
  const snapshotChapters = buildChapterIndex(snapshot.chapters);

  // ---- 合并章节与句子 -------------------------------------------------
  const revertSentences: RestorePlan['revertSentences'] = [];
  const newSentences: RestorePlan['newSentences'] = [];
  const restoredSentences: RestorePlan['restoredSentences'] = [];

  const mergedChapters: Chapter[] = [];
  const chapterIds = new Set<string>([
    ...snapshot.chapters.map((chapter) => chapter.id),
    ...document.chapters.map((chapter) => chapter.id)
  ]);
  for (const chapterId of chapterIds) {
    const current = currentChapters.get(chapterId);
    const old = snapshotChapters.get(chapterId);
    if (current && !old) {
      // 快照之后新增的章节整体保留
      mergedChapters.push(clone(current.chapter));
      for (const sentence of current.chapter.sentences) {
        newSentences.push({
          id: sentence.id,
          chapterId: chapterId,
          chapterTitle: current.chapter.title,
          order: sentence.order,
          text: sentence.text
        });
      }
      continue;
    }
    if (old && !current) {
      // 当前已删章节随旧稿恢复
      mergedChapters.push(clone(old.chapter));
      for (const sentence of old.chapter.sentences) {
        restoredSentences.push({
          id: sentence.id,
          chapterId: chapterId,
          chapterTitle: old.chapter.title,
          order: sentence.order,
          text: sentence.text
        });
      }
      continue;
    }
    if (!old || !current) continue;

    const sentences: Sentence[] = [];
    for (const oldSentence of old.chapter.sentences) {
      const currentSentence = current.sentenceById.get(oldSentence.id);
      if (!currentSentence) {
        sentences.push(clone(oldSentence));
        restoredSentences.push({
          id: oldSentence.id,
          chapterId: chapterId,
          chapterTitle: old.chapter.title,
          order: oldSentence.order,
          text: oldSentence.text
        });
        continue;
      }
      if (currentSentence.text !== oldSentence.text) {
        // 并存句以旧稿文字为准；以旧稿文字重新切词，优先沿用当前仍出现的 token，
        // 其次保留旧稿 token（让随旧稿恢复的词级注释不断锚），
        // 两边都对不上的词级引用随后统一迁到所属句。
        const tokenPool = mergeTokenPool(oldSentence.tokens, currentSentence.tokens);
        const tokens = tokenizeText(oldSentence.text, oldSentence.id, tokenPool);
        sentences.push({ id: oldSentence.id, order: oldSentence.order, text: oldSentence.text, tokens });
        revertSentences.push({
          id: oldSentence.id,
          chapterId: chapterId,
          chapterTitle: old.chapter.title,
          order: oldSentence.order,
          currentText: currentSentence.text,
          snapshotText: oldSentence.text
        });
      } else {
        sentences.push(clone(currentSentence));
      }
    }
    for (const currentSentence of current.chapter.sentences) {
      if (!old.sentenceById.has(currentSentence.id)) {
        sentences.push(clone(currentSentence));
        newSentences.push({
          id: currentSentence.id,
          chapterId: chapterId,
          chapterTitle: current.chapter.title,
          order: currentSentence.order,
          text: currentSentence.text
        });
      }
    }
    sentences.forEach((sentence, index) => {
      sentence.order = index + 1;
    });
    mergedChapters.push({ ...clone(old.chapter), sentences });
  }

  // ---- 合并注释 -------------------------------------------------------
  const snapshotAnnotations = new Map(snapshot.annotations.map((annotation) => [annotation.id, annotation]));
  const currentAnnotations = new Map(document.annotations.map((annotation) => [annotation.id, annotation]));

  const newAnnotations: RestoreAnnotationEntry[] = [];
  const revisedAnnotations: RestoreAnnotationEntry[] = [];
  const restoredAnnotations: RestoreAnnotationEntry[] = [];
  const migratedWordAnnotations: RestorePlan['migratedWordAnnotations'] = [];
  const mergedAnnotations: Annotation[] = [];

  const mergedIndex = buildChapterIndex(mergedChapters);

  // 旧稿 token 与合并后 token 的同文映射：恢复旧稿文字时，引用旧 ID 的词级注释
  // 若在合并正文中仍能找到同文词语，则改写为规范 token ID，保持词级引用。
  function canonicalTokenByText(chapterId: string, sentenceId: string, text: string) {
    const index = mergedIndex.get(chapterId);
    return index?.sentenceById.get(sentenceId)?.tokens.find((token) => token.text === text);
  }

  function resolveWordAnchor(annotation: Annotation): { sentenceId: string; wordText: string } | null {
    if (annotation.anchorType !== 'word') return null;
    // 词语仍在合并后的正文中：保持词级引用
    for (const entry of mergedIndex.values()) {
      for (const sentence of entry.chapter.sentences) {
        if (sentence.tokens.some((item) => item.id === annotation.anchorId)) return null;
      }
    }
    // 在来源侧定位该词级引用所属句与词面
    const sources: { chapters: Chapter[] }[] = [document, snapshot];
    for (const source of sources) {
      for (const chapter of source.chapters) {
        for (const sentence of chapter.sentences) {
          const token = sentence.tokens.find((item) => item.id === annotation.anchorId);
          if (!token || !mergedIndex.get(chapter.id)?.sentenceById.has(sentence.id)) continue;
          // 同文词语仍在恢复后的句中：归一到规范 token，词级引用不悬空
          const canonical = canonicalTokenByText(chapter.id, sentence.id, token.text);
          if (canonical) {
            annotation.anchorId = canonical.id;
            return null;
          }
          // 词语已随旧稿正文消失：迁到所属句
          return { sentenceId: sentence.id, wordText: token.text.trim() };
        }
      }
    }
    return null;
  }

  function anchorLabelFor(annotation: Annotation): string {
    if (annotation.anchorType === 'chapter') {
      return mergedIndex.get(annotation.anchorId)?.chapter.title ?? '未知章节';
    }
    for (const entry of mergedIndex.values()) {
      const sentence = entry.sentenceById.get(annotation.anchorId);
      if (sentence) return `${entry.chapter.title} · 第 ${sentence.order} 句`;
      for (const item of entry.chapter.sentences) {
        const token = item.tokens.find((token) => token.id === annotation.anchorId);
        if (token) return `${entry.chapter.title} · “${token.text.trim()}”`;
      }
    }
    return '引用目标已迁移到所属句';
  }

  function entryFor(annotation: Annotation): RestoreAnnotationEntry {
    return {
      id: annotation.id,
      title: annotation.title,
      source: annotation.source,
      kind: annotation.kind,
      anchorLabel: anchorLabelFor(annotation),
      body: annotation.body
    };
  }

  const allAnnotationIds = new Set<string>([...snapshotAnnotations.keys(), ...currentAnnotations.keys()]);
  // 先记录每条注释在恢复清单中的暂定归属，随后统一处理悬空词级引用
  const provisionalKind = new Map<string, 'new' | 'revised' | 'restored' | 'unchanged'>();
  for (const id of allAnnotationIds) {
    const current = currentAnnotations.get(id);
    const old = snapshotAnnotations.get(id);
    const merged = clone(current ?? old)!;
    mergedAnnotations.push(merged);

    if (current && !old) {
      provisionalKind.set(id, 'new');
    } else if (old && !current) {
      provisionalKind.set(id, 'restored');
    } else if (current && old && annotationRevisionSignature(current) !== annotationRevisionSignature(old)) {
      provisionalKind.set(id, 'revised');
    } else {
      provisionalKind.set(id, 'unchanged');
    }
  }

  // 统一迁移：合并后的正文中找不到目标 token 的词级引用，一律迁到所属句。
  // 新补注释、随旧稿恢复的注释、并存注释都在此处理，保证引用关系不悬空。
  for (const merged of mergedAnnotations) {
    const migration = resolveWordAnchor(merged);
    if (!migration) continue;
    merged.anchorId = migration.sentenceId;
    merged.anchorType = 'sentence';
    if (!merged.title.includes('引用已随修订迁移')) {
      merged.title = `${merged.title}（引用已随修订迁移）`;
    }
    merged.updatedAt = new Date().toISOString();
    migratedWordAnnotations.push({
      ...entryFor(merged),
      wordText: migration.wordText,
      sentenceId: migration.sentenceId,
      sentenceLabel: anchorLabelFor(merged)
    });
  }

  for (const merged of mergedAnnotations) {
    const migrated = migratedWordAnnotations.some((item) => item.id === merged.id);
    if (migrated) continue; // 已计入“词级引用迁到所属句”分组
    const kind = provisionalKind.get(merged.id);
    const entry = entryFor(merged);
    if (kind === 'new') newAnnotations.push(entry);
    else if (kind === 'revised') revisedAnnotations.push(entry);
    else if (kind === 'restored') restoredAnnotations.push(entry);
  }

  // ---- 冲突闸门 -------------------------------------------------------
  const finalDocument: TextDocument = {
    ...document,
    chapters: mergedChapters,
    annotations: mergedAnnotations
  };

  // 旧快照中“已解决”的冲突组（同一引用目标 + 同一注释类型）
  const snapshotGroups = new Map<string, Annotation[]>();
  // 快照词语 token → 所属句，便于检出“词级冲突解决后新来源挂到所属句”的情形
  const tokenToSentence = new Map<string, string>();
  for (const chapter of snapshot.chapters) {
    for (const sentence of chapter.sentences) {
      for (const token of sentence.tokens) tokenToSentence.set(token.id, sentence.id);
    }
  }
  for (const annotation of snapshot.annotations) {
    if (annotation.conflictState !== 'resolved') continue;
    const key = `${annotation.anchorId}:${annotation.kind}`;
    snapshotGroups.set(key, [...(snapshotGroups.get(key) ?? []), annotation]);
  }

  // 为最终注释反查它在快照侧所属的分组键：
  // 并存注释直接用旧锚点；新注释用当前锚点（词级引用迁移后落到所属句，
  // 因此句级已解决组、以及词级组解决后新来源挂到所属句，都能被重新触发）。
  function candidateSnapshotKeys(annotation: Annotation, finalAnchorId: string): string[] {
    const keys = new Set<string>();
    const old = snapshotAnnotations.get(annotation.id);
    if (old) keys.add(`${old.anchorId}:${old.kind}`);
    const current = currentAnnotations.get(annotation.id);
    if (current) keys.add(`${current.anchorId}:${current.kind}`);
    keys.add(`${finalAnchorId}:${annotation.kind}`);
    // 句级锚点同时匹配该句下快照已解决的词级组
    if (annotation.anchorType === 'sentence') {
      for (const [tokenId, sentenceId] of tokenToSentence) {
        if (sentenceId === finalAnchorId) keys.add(`${tokenId}:${annotation.kind}`);
      }
    }
    return Array.from(keys);
  }

  const regressedConflicts: RestoreRegressedConflict[] = [];
  const reportedKeys = new Set<string>();
  for (const merged of mergedAnnotations) {
    // 随旧稿恢复的已解决注释本身不算新来源；只看快照之后仍开放的注释
    if (merged.conflictState === 'resolved') continue;
    const matchedKey = candidateSnapshotKeys(merged, merged.anchorId).find((key) => {
      const items = snapshotGroups.get(key);
      return items && items.length > 0;
    });
    if (!matchedKey || reportedKeys.has(matchedKey)) continue;
    const snapshotGroup = snapshotGroups.get(matchedKey)!;

    // 新条文：
    //  - 快照中不存在的注释，且正文不同于当时已解决的任一来源；或
    //  - 并存注释在快照之后被改写，正文与旧稿版本不同。
    // 同文异源（仅来源署名不同）不算新冲突，按“已解决”处理。
    const snapshotBodies = new Set(snapshotGroup.map((item) => item.body.trim()));
    const openRegressions = mergedAnnotations.filter((item) => {
      if (item.conflictState === 'resolved') return false;
      return candidateSnapshotKeys(item, item.anchorId).includes(matchedKey);
    });
    const hasNewSource = openRegressions.some((item) => {
      const old = snapshotAnnotations.get(item.id);
      if (old) return old.body.trim() !== item.body.trim();
      return !snapshotBodies.has(item.body.trim());
    });
    if (!hasNewSource) continue;
    reportedKeys.add(matchedKey);

    const resolvedExample = snapshotGroup[0];
    let anchorLabel = getTargetLabel(finalDocument, resolvedExample);
    if (anchorLabel === '引用目标已迁移到所属句') {
      const snapshotDoc: TextDocument = {
        ...document,
        chapters: snapshot.chapters,
        annotations: snapshot.annotations
      };
      anchorLabel = getTargetLabel(snapshotDoc, resolvedExample);
    }

    regressedConflicts.push({
      key: matchedKey,
      kind: snapshotGroup[0].kind,
      anchorLabel,
      snapshotSources: snapshotGroup.map((item) => item.source),
      currentSources: openRegressions.map((item) => ({
        annotationId: item.id,
        title: item.title,
        source: item.source,
        body: item.body
      }))
    });
  }

  return {
    snapshotId,
    snapshotLabel: snapshot.label,
    revertSentences,
    newSentences,
    restoredSentences,
    newAnnotations,
    revisedAnnotations,
    restoredAnnotations,
    migratedWordAnnotations,
    regressedConflicts,
    chapters: mergedChapters,
    annotations: mergedAnnotations
  };
}

/** 按恢复计划写入正文与注释。调用前必须确认 regressedConflicts 为空。 */
export function applyRestorePlan(document: TextDocument, plan: RestorePlan) {
  document.chapters = clone(plan.chapters);
  document.annotations = clone(plan.annotations);
}
