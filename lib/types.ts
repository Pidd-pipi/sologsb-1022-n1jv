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

export interface RestoreSentenceItem {
  chapterId: string;
  chapterTitle: string;
  sentenceId: string;
  order: number;
  currentText: string;
  snapshotText: string;
}

export interface RestoreAnnotationItem {
  annotation: Annotation;
  changedFields: string[];
}

export interface RestoreMigrationItem {
  annotationId: string;
  annotationTitle: string;
  source: string;
  tokenText: string;
  sentenceId: string;
  sentenceLabel: string;
}

export interface RestoreConflictItem {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  resolved: Annotation[];
  incoming: Annotation[];
}

export interface RestorePlan {
  snapshotId: string;
  snapshotLabel: string;
  snapshotCreatedAt: string;
  revertSentences: RestoreSentenceItem[];
  restoredSentences: RestoreSentenceItem[];
  keptSentences: RestoreSentenceItem[];
  newAnnotations: Annotation[];
  revisedAnnotations: RestoreAnnotationItem[];
  unchangedAnnotationCount: number;
  migrations: RestoreMigrationItem[];
  blockingConflicts: RestoreConflictItem[];
  mergedChapters: Chapter[];
}
