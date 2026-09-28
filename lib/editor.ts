import type {
  Annotation,
  AnnotationKind,
  Chapter,
  ConflictGroup,
  EditorState,
  RestoreConflictItem,
  RestorePlan,
  SearchResult,
  Sentence,
  TextDocument,
  WorkspaceState
} from './types';

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

const RESTORE_FIELD_LABELS: Array<{ key: keyof Annotation; label: string }> = [
  { key: 'title', label: '标题' },
  { key: 'body', label: '正文' },
  { key: 'source', label: '来源' },
  { key: 'kind', label: '类型' },
  { key: 'anchorId', label: '引用目标' },
  { key: 'anchorType', label: '引用级别' },
  { key: 'references', label: '引用注释' },
  { key: 'tags', label: '标签' }
];

function describeAnchorInChapters(
  chapters: Chapter[],
  anchorId: string,
  anchorType: Annotation['anchorType']
): string {
  for (const chapter of chapters) {
    if (anchorType === 'chapter' && chapter.id === anchorId) return chapter.title;
    const sentence = chapter.sentences.find((item) => item.id === anchorId);
    if (anchorType === 'sentence' && sentence) return `${chapter.title} · 第 ${sentence.order} 句`;
    for (const item of chapter.sentences) {
      const token = item.tokens.find((token) => token.id === anchorId);
      if (token) return `${chapter.title} · “${token.text.trim()}”`;
    }
  }
  return '文本片段';
}

interface EffectiveAnnotation {
  annotation: Annotation;
  anchorId: string;
  anchorType: Annotation['anchorType'];
}

/**
 * 生成旧快照的恢复清单：句子按 ID 合并（旧稿正文覆盖当前句，新增句保留），
 * 注释一律保留当前版本；旧稿中已消失的词级引用将迁移到所属句。
 * 同时检查“快照中已解决、但当前因新来源再次出现”的冲突组，作为阻断项返回。
 * 该函数不修改入参，任何写入都由 applyRestorePlan 在用户确认后执行。
 */
export function planRestore(document: TextDocument, snapshotId: string): RestorePlan | null {
  const snapshot = document.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return null;

  const mergedChapters: Chapter[] = [];
  const revertSentences: RestorePlan['revertSentences'] = [];
  const restoredSentences: RestorePlan['restoredSentences'] = [];
  const keptSentences: RestorePlan['keptSentences'] = [];

  snapshot.chapters.forEach((snapshotChapter, index) => {
    const currentChapter = document.chapters.find((item) => item.id === snapshotChapter.id);
    const mergedChapter: Chapter = {
      ...clone(snapshotChapter),
      order: currentChapter?.order ?? snapshotChapter.order,
      sentences: []
    };
    for (const snapshotSentence of snapshotChapter.sentences) {
      const currentSentence = currentChapter?.sentences.find((item) => item.id === snapshotSentence.id);
      mergedChapter.sentences.push(clone(snapshotSentence));
      if (!currentSentence) {
        restoredSentences.push({
          chapterId: snapshotChapter.id,
          chapterTitle: snapshotChapter.title,
          sentenceId: snapshotSentence.id,
          order: snapshotSentence.order,
          currentText: '',
          snapshotText: snapshotSentence.text
        });
      } else if (currentSentence.text !== snapshotSentence.text) {
        revertSentences.push({
          chapterId: snapshotChapter.id,
          chapterTitle: snapshotChapter.title,
          sentenceId: snapshotSentence.id,
          order: snapshotSentence.order,
          currentText: currentSentence.text,
          snapshotText: snapshotSentence.text
        });
      }
    }
    for (const currentSentence of currentChapter?.sentences ?? []) {
      if (!snapshotChapter.sentences.some((item) => item.id === currentSentence.id)) {
        mergedChapter.sentences.push(clone(currentSentence));
        keptSentences.push({
          chapterId: snapshotChapter.id,
          chapterTitle: snapshotChapter.title,
          sentenceId: currentSentence.id,
          order: currentSentence.order,
          currentText: currentSentence.text,
          snapshotText: ''
        });
      }
    }
    mergedChapters[index] = mergedChapter;
  });

  // 快照之后新增的章节（当前界面无此操作，仍稳妥保留）。
  for (const currentChapter of document.chapters) {
    if (!snapshot.chapters.some((item) => item.id === currentChapter.id)) {
      mergedChapters.push(clone(currentChapter));
      for (const currentSentence of currentChapter.sentences) {
        keptSentences.push({
          chapterId: currentChapter.id,
          chapterTitle: currentChapter.title,
          sentenceId: currentSentence.id,
          order: currentSentence.order,
          currentText: currentSentence.text,
          snapshotText: ''
        });
      }
    }
  }

  // 合并后仍然存在的词级 token 索引；不在其中的词级引用需要迁移到所属句。
  const mergedTokenIds = new Set<string>();
  const mergedSentenceById = new Map<string, { chapter: Chapter; sentence: Sentence }>();
  for (const chapter of mergedChapters) {
    for (const sentence of chapter.sentences) {
      mergedSentenceById.set(sentence.id, { chapter, sentence });
      for (const token of sentence.tokens) mergedTokenIds.add(token.id);
    }
  }

  // 快照侧 token → 所属句，用于把快照分组的词级锚点归一化到合并后的锚点。
  const snapshotTokenOwner = new Map<string, string>();
  for (const chapter of snapshot.chapters) {
    for (const sentence of chapter.sentences) {
      for (const token of sentence.tokens) snapshotTokenOwner.set(token.id, sentence.id);
    }
  }

  const currentSentenceByToken = new Map<string, { chapter: Chapter; sentence: Sentence; tokenText: string }>();
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      for (const token of sentence.tokens) {
        currentSentenceByToken.set(token.id, { chapter, sentence, tokenText: token.text.trim() });
      }
    }
  }

  // 任一侧的词级锚点在合并稿中消失时，归一化到所属句。
  function toMergedAnchor(anchorId: string, anchorType: Annotation['anchorType']) {
    if (anchorType === 'word' && !mergedTokenIds.has(anchorId)) {
      const ownerId = snapshotTokenOwner.get(anchorId) ?? currentSentenceByToken.get(anchorId)?.sentence.id;
      if (ownerId && mergedSentenceById.has(ownerId)) {
        return { anchorId: ownerId, anchorType: 'sentence' as const };
      }
    }
    return { anchorId, anchorType };
  }

  const migrations: RestorePlan['migrations'] = [];
  const effectiveByAnnotationId = new Map<string, EffectiveAnnotation>();
  for (const annotation of document.annotations) {
    let { anchorId, anchorType } = annotation;
    if (anchorType === 'word' && !mergedTokenIds.has(anchorId)) {
      const owner = currentSentenceByToken.get(anchorId);
      const ownerSentence = owner
        ? { id: owner.sentence.id, label: `${owner.chapter.title} · 第 ${owner.sentence.order} 句`, tokenText: owner.tokenText }
        : undefined;
      if (ownerSentence) {
        migrations.push({
          annotationId: annotation.id,
          annotationTitle: annotation.title,
          source: annotation.source,
          tokenText: ownerSentence.tokenText,
          sentenceId: ownerSentence.id,
          sentenceLabel: ownerSentence.label
        });
        anchorId = ownerSentence.id;
        anchorType = 'sentence';
      }
    }
    effectiveByAnnotationId.set(annotation.id, { annotation, anchorId, anchorType });
  }

  // 注释清单：新增、修订保留当前版本；快照之后删除的不恢复。
  const newAnnotations: Annotation[] = [];
  const revisedAnnotations: RestorePlan['revisedAnnotations'] = [];
  let unchangedAnnotationCount = 0;
  for (const annotation of document.annotations) {
    const snapshotAnnotation = snapshot.annotations.find((item) => item.id === annotation.id);
    if (!snapshotAnnotation) {
      newAnnotations.push(annotation);
      continue;
    }
    const changedFields = RESTORE_FIELD_LABELS.filter(({ key }) => {
      const currentValue = annotation[key];
      const snapshotValue = snapshotAnnotation[key];
      return Array.isArray(currentValue) || Array.isArray(snapshotValue)
        ? JSON.stringify(currentValue) !== JSON.stringify(snapshotValue)
        : currentValue !== snapshotValue;
    }).map(({ label }) => label);
    if (changedFields.length) {
      revisedAnnotations.push({ annotation, changedFields });
    } else {
      unchangedAnnotationCount += 1;
    }
  }

  // 阻断项：快照里同一“引用目标 + 类型”的冲突已全部解决，
  // 而当前（合并引用迁移后）又出现快照之外的新来源。
  const blockingConflicts: RestoreConflictItem[] = [];
  const snapshotGroups = new Map<string, Annotation[]>();
  for (const annotation of snapshot.annotations) {
    const merged = toMergedAnchor(annotation.anchorId, annotation.anchorType);
    const key = `${merged.anchorId}:${annotation.kind}`;
    snapshotGroups.set(key, [...(snapshotGroups.get(key) ?? []), annotation]);
  }
  const effectiveGroups = new Map<string, EffectiveAnnotation[]>();
  for (const effective of effectiveByAnnotationId.values()) {
    const key = `${effective.anchorId}:${effective.annotation.kind}`;
    effectiveGroups.set(key, [...(effectiveGroups.get(key) ?? []), effective]);
  }
  for (const [key, snapshotItems] of snapshotGroups) {
    const resolved = snapshotItems.filter((item) => item.conflictState === 'resolved');
    const distinctBodies = new Set(resolved.map((item) => item.body.trim()));
    if (resolved.length < 2 || distinctBodies.size < 2) continue;
    const snapshotIds = new Set(snapshotItems.map((item) => item.id));
    const currentItems = effectiveGroups.get(key) ?? [];
    const incoming = currentItems
      .filter((item) => !snapshotIds.has(item.annotation.id) && item.annotation.conflictState === 'open')
      .map((item) => item.annotation);
    const currentBodies = new Set(currentItems.map((item) => item.annotation.body.trim()));
    if (incoming.length && currentBodies.size > 1) {
      const first = snapshotItems[0];
      const merged = toMergedAnchor(first.anchorId, first.anchorType);
      blockingConflicts.push({
        key,
        anchorId: merged.anchorId,
        anchorType: merged.anchorType,
        kind: first.kind,
        anchorLabel: describeAnchorInChapters(mergedChapters, merged.anchorId, merged.anchorType),
        resolved,
        incoming
      });
    }
  }

  return {
    snapshotId: snapshot.id,
    snapshotLabel: snapshot.label,
    snapshotCreatedAt: snapshot.createdAt,
    revertSentences,
    restoredSentences,
    keptSentences,
    newAnnotations,
    revisedAnnotations,
    unchangedAnnotationCount,
    migrations,
    blockingConflicts,
    mergedChapters
  };
}

/** 按恢复清单写入：仅替换章节正文，并迁移清单中的词级引用；当前注释整体保留。 */
export function applyRestorePlan(document: TextDocument, plan: RestorePlan) {
  document.chapters = clone(plan.mergedChapters);
  const migrationBySentence = new Map(plan.migrations.map((item) => [item.annotationId, item.sentenceId]));
  for (const annotation of document.annotations) {
    const sentenceId = migrationBySentence.get(annotation.id);
    if (!sentenceId) continue;
    annotation.anchorId = sentenceId;
    annotation.anchorType = 'sentence';
    annotation.title = annotation.title.endsWith('（引用已随修订迁移）')
      ? annotation.title
      : `${annotation.title}（引用已随修订迁移）`;
    annotation.updatedAt = new Date().toISOString();
  }
}
