export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  updatedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
}

export interface RestoreSentenceEntry {
  id: string;
  chapterId: string;
  chapterTitle: string;
  order: number;
}

export interface RestoreAnnotationEntry {
  id: string;
  title: string;
  source: string;
  kind: AnnotationKind;
  anchorLabel: string;
  body: string;
}

export interface RestoreMigrationEntry extends RestoreAnnotationEntry {
  wordText: string;
  sentenceId: string;
  sentenceLabel: string;
}

export interface RestoreRegressedConflict {
  key: string;
  kind: AnnotationKind;
  anchorLabel: string;
  snapshotSources: string[];
  currentSources: { annotationId: string; title: string; source: string; body: string }[];
}

export interface RestorePlan {
  snapshotId: string;
  snapshotLabel: string;
  /** 旧稿与当前并存但正文不同：恢复后采用旧稿文字 */
  revertSentences: (RestoreSentenceEntry & { currentText: string; snapshotText: string })[];
  /** 快照之后新增的句子：恢复后保留 */
  newSentences: (RestoreSentenceEntry & { text: string })[];
  /** 当前已删、旧稿中存在的句子：随旧稿恢复 */
  restoredSentences: (RestoreSentenceEntry & { text: string })[];
  /** 快照之后新增的注释：恢复后保留 */
  newAnnotations: RestoreAnnotationEntry[];
  /** 快照后被修订的既有注释：恢复后保留当前修订 */
  revisedAnnotations: RestoreAnnotationEntry[];
  /** 当前已删、旧稿中存在的注释：随旧稿恢复 */
  restoredAnnotations: RestoreAnnotationEntry[];
  /** 旧稿正文中目标词语已不存在：词级引用迁到所属句 */
  migratedWordAnnotations: RestoreMigrationEntry[];
  /** 旧快照已解决、当前又出现新来源的冲突；存在时禁止写入 */
  regressedConflicts: RestoreRegressedConflict[];
  chapters: Chapter[];
  annotations: Annotation[];
}
