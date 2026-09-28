'use client';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Kbd,
  ScrollShadow,
  Select,
  SelectItem,
  Tab,
  Tabs,
  Textarea,
  Tooltip
} from '@heroui/react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  FileDown,
  FileJson,
  GitCompareArrows,
  Keyboard,
  Link2,
  ListChecks,
  ListTree,
  Pencil,
  Plus,
  Printer,
  Redo2,
  Save,
  Search,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { annotationKindLabels, anchorTypeLabels, initialDocument, tokenizeText } from '@/lib/data';
import {
  STORAGE_KEY,
  applyRestorePlan,
  clone,
  collectSearchResults,
  createInitialEditorState,
  editorReducer,
  getConflictGroups,
  getSentence,
  getTargetLabel,
  kindLabel,
  planRestore,
  removeAnnotationReferences,
  updateSentenceText
} from '@/lib/editor';
import type {
  Annotation,
  AnnotationKind,
  AnchorType,
  ConflictGroup,
  RestorePlan,
  Sentence,
  TextDocument,
  ViewMode,
  WorkspaceState
} from '@/lib/types';

const MODE_COPY: Record<ViewMode, { label: string; hint: string }> = {
  reading: { label: '阅读版', hint: '只读正文，脚注按引用编号展开' },
  editing: { label: '编辑版', hint: '选择章节、句子或词语并维护注释' },
  critical: { label: '校勘版', hint: '逐句对照来源、异文与争议内容' }
};

const kindColors: Record<AnnotationKind, 'primary' | 'warning' | 'secondary' | 'success'> = {
  footnote: 'primary',
  variant: 'warning',
  background: 'secondary',
  crossref: 'success'
};

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildHtml(document: TextDocument) {
  const sections = document.chapters
    .map((chapter) => {
      const sentences = chapter.sentences
        .map((sentence) => {
          const notes = document.annotations.filter(
            (annotation) => annotation.anchorId === sentence.id && annotation.anchorType === 'sentence'
          );
          const suffix = notes
            .map((annotation) => `<sup title="${escapeHtml(annotation.title)}">[${escapeHtml(annotation.source)}]</sup>`)
            .join('');
          return `<p id="${escapeHtml(sentence.id)}">${escapeHtml(sentence.text)}${suffix}</p>`;
        })
        .join('\n');
      return `<section><h2>${escapeHtml(chapter.title)}</h2><p class="summary">${escapeHtml(chapter.summary)}</p>${sentences}</section>`;
    })
    .join('\n');

  const notes = document.annotations
    .map(
      (annotation) =>
        `<li><b>${escapeHtml(annotation.title)}</b> <span>${escapeHtml(annotation.source)}</span><br>${escapeHtml(annotation.body)}</li>`
    )
    .join('\n');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(document.title)}</title>
<style>body{max-width:780px;margin:48px auto;padding:0 28px;font:17px/1.9 Georgia,"Noto Serif SC",serif;color:#29251f}h1{text-align:center}h2{margin-top:2.4em;border-bottom:1px solid #ddd;padding-bottom:.35em}.summary{color:#6b665d}li{margin:.8em 0}small{color:#777}</style></head>
<body><h1>${escapeHtml(document.title)}</h1><p style="text-align:center">${escapeHtml(document.author)} · ${escapeHtml(document.edition)}</p>
${sections}<hr><h2>注释与校记</h2><ol>${notes}</ol><p><small>导出时间：${new Date().toLocaleString('zh-CN')}</small></p></body></html>`;
}

function sentenceAnnotationCount(document: TextDocument, sentence: Sentence) {
  return document.annotations.filter(
    (annotation) =>
      annotation.anchorId === sentence.id ||
      sentence.tokens.some((token) => token.id === annotation.anchorId)
  ).length;
}

function nextSentence(document: TextDocument, currentId: string) {
  for (const chapter of document.chapters) {
    const index = chapter.sentences.findIndex((sentence) => sentence.id === currentId);
    if (index >= 0) {
      if (index < chapter.sentences.length - 1) return { chapterId: chapter.id, sentenceId: chapter.sentences[index + 1].id };
      const chapterIndex = document.chapters.findIndex((item) => item.id === chapter.id);
      const nextChapter = document.chapters[chapterIndex + 1];
      if (nextChapter?.sentences[0]) return { chapterId: nextChapter.id, sentenceId: nextChapter.sentences[0].id };
    }
  }
  return null;
}

function previousSentence(document: TextDocument, currentId: string) {
  for (const chapter of document.chapters) {
    const index = chapter.sentences.findIndex((sentence) => sentence.id === currentId);
    if (index > 0) return { chapterId: chapter.id, sentenceId: chapter.sentences[index - 1].id };
  }
  return null;
}

interface AnnotationFormProps {
  anchorId: string;
  anchorType: AnchorType;
  anchorPreview: string;
  onSubmit: (values: Omit<Annotation, 'id' | 'status' | 'conflictState' | 'updatedAt'>) => void;
}

function AnnotationForm({ anchorId, anchorType, anchorPreview, onSubmit }: AnnotationFormProps) {
  const [kind, setKind] = useState<AnnotationKind>('footnote');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState('整理者');
  const [references, setReferences] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState('');

  function submit() {
    if (!title.trim() || !body.trim()) {
      setError('请填写标题和注释正文。');
      return;
    }
    onSubmit({
      anchorId,
      anchorType,
      kind,
      title: title.trim(),
      body: body.trim(),
      source: source.trim() || '未署名',
      references: references
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      tags: tags
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    });
    setTitle('');
    setBody('');
    setReferences('');
    setTags('');
    setError('');
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
        当前目标：<span className="font-semibold text-stone-800">{anchorTypeLabels[anchorType]} · {anchorPreview}</span>
      </div>
      <Select
        aria-label="注释类型"
        label="注释类型"
        selectedKeys={new Set([kind])}
        onSelectionChange={(keys) => setKind(Array.from(keys)[0] as AnnotationKind)}
      >
        {Object.entries(annotationKindLabels).map(([value, label]) => (
          <SelectItem key={value}>{label}</SelectItem>
        ))}
      </Select>
      <Input label="标题" value={title} onValueChange={setTitle} placeholder="例如：北冥释义" />
      <Textarea
        label="正文"
        value={body}
        onValueChange={setBody}
        minRows={3}
        placeholder="记录校勘依据、背景或互见关系"
      />
      <div className="grid grid-cols-2 gap-3">
        <Input label="来源" value={source} onValueChange={setSource} />
        <Input label="标签" value={tags} onValueChange={setTags} placeholder="地理, 异文" />
      </div>
      <Input
        label="引用注释 ID"
        value={references}
        onValueChange={setReferences}
        placeholder="annotation-1, annotation-3"
        startContent={<Link2 className="h-4 w-4 text-stone-400" />}
      />
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      <Button color="primary" className="w-full" onPress={submit} startContent={<Plus className="h-4 w-4" />}>
        添加注释
      </Button>
    </div>
  );
}

interface AnnotationCardProps {
  annotation: Annotation;
  document: TextDocument;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
}

function AnnotationCard({ annotation, document, selected, onSelect, onUpdate, onDelete }: AnnotationCardProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(annotation.title);
  const [body, setBody] = useState(annotation.body);
  const [source, setSource] = useState(annotation.source);

  useEffect(() => {
    setTitle(annotation.title);
    setBody(annotation.body);
    setSource(annotation.source);
  }, [annotation.id, annotation.title, annotation.body, annotation.source]);

  return (
    <Card
      shadow="none"
      className={`border ${selected ? 'border-amber-500 bg-amber-50/60' : 'border-stone-200 bg-white'}`}
    >
      <CardBody className="gap-3 p-3">
        <button type="button" className="w-full text-left focus-ring" onClick={onSelect}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <Chip size="sm" color={kindColors[annotation.kind]} variant="flat">
                  {kindLabel(annotation.kind)}
                </Chip>
                {annotation.conflictState === 'open' ? <Chip size="sm" color="danger" variant="bordered">争议中</Chip> : null}
              </div>
              <h4 className="mt-2 font-semibold text-stone-900">{annotation.title}</h4>
            </div>
            <span className="whitespace-nowrap text-xs text-stone-500">{annotation.source}</span>
          </div>
          {!editing ? <p className="mt-2 text-sm leading-6 text-stone-700">{annotation.body}</p> : null}
        </button>

        {editing ? (
          <div className="space-y-2">
            <Input size="sm" label="标题" value={title} onValueChange={setTitle} />
            <Textarea size="sm" minRows={3} label="正文" value={body} onValueChange={setBody} />
            <Input size="sm" label="来源" value={source} onValueChange={setSource} />
            <div className="flex gap-2">
              <Button
                size="sm"
                color="primary"
                onPress={() => {
                  onUpdate({ title: title.trim() || annotation.title, body: body.trim() || annotation.body, source: source.trim() || annotation.source });
                  setEditing(false);
                }}
              >
                保存修改
              </Button>
              <Button size="sm" variant="light" onPress={() => setEditing(false)}>取消</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
            <span>{getTargetLabel(document, annotation)}</span>
            {annotation.references.length ? (
              <span className="flex items-center gap-1"><Link2 className="h-3 w-3" />引用 {annotation.references.length} 条</span>
            ) : null}
            <span className="ml-auto flex gap-1">
              <Button isIconOnly size="sm" variant="light" aria-label="编辑注释" onPress={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button isIconOnly size="sm" variant="light" color="danger" aria-label="删除注释" onPress={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

interface RestorePreviewSectionProps {
  title: string;
  tone: 'revert' | 'keep';
  emptyText: string;
  items: { key: string; heading: string; from?: string; to: string }[];
}

function RestorePreviewSection({ title, tone, emptyText, items }: RestorePreviewSectionProps) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3">
      <h4 className="text-xs font-semibold text-stone-800">{title}</h4>
      {items.length ? (
        <ul className="mt-2 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="text-xs leading-5">
              <div className={`font-semibold ${tone === 'revert' ? 'text-amber-800' : 'text-green-800'}`}>{item.heading}</div>
              {item.from ? <p className="text-stone-400 line-through">现：{item.from}</p> : null}
              <p className={tone === 'revert' ? 'text-stone-700' : 'text-stone-600'}>
                {item.from ? '旧：' : '留：'}
                {item.to}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-stone-500">{emptyText}</p>
      )}
    </div>
  );
}

export function TextAnnotationWorkbench() {
  const [state, dispatch] = useReducer(editorReducer, initialDocument, createInitialEditorState);
  const [hydrated, setHydrated] = useState(false);
  const [online, setOnline] = useState(true);
  const [savedAt, setSavedAt] = useState('');
  const [rightTab, setRightTab] = useState('annotations');
  const [pendingAnchor, setPendingAnchor] = useState<{ id: string; type: AnchorType; preview: string } | null>(null);
  const [editingSentenceDraft, setEditingSentenceDraft] = useState('');
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
  const [leftVersionId, setLeftVersionId] = useState('snapshot-base');
  const [rightVersionId, setRightVersionId] = useState('current');
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [apiMessage, setApiMessage] = useState('模拟接口待命');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const workspace = state.workspace;
  const document = workspace.document;
  const selectedChapter =
    document.chapters.find((chapter) => chapter.id === workspace.selectedChapterId) ?? document.chapters[0];
  const selectedSentence = getSentence(document, workspace.selectedSentenceId);
  const conflicts = useMemo(() => getConflictGroups(document), [document]);
  const searchResults = useMemo(() => collectSearchResults(document, workspace.query), [document, workspace.query]);

  const anchor = pendingAnchor ?? {
    id: selectedSentence?.id ?? selectedChapter?.id ?? '',
    type: (selectedSentence ? 'sentence' : 'chapter') as AnchorType,
    preview: selectedSentence?.text ?? selectedChapter?.title ?? ''
  };
  const anchorAnnotations = document.annotations.filter((annotation) => annotation.anchorId === anchor.id);
  const selectedAnnotation = document.annotations.find((item) => item.id === workspace.selectedAnnotationId) ?? null;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as WorkspaceState;
        if (stored.document?.chapters?.length) {
          dispatch({ type: 'hydrate', workspace: stored });
          if (stored.document.snapshots[0]) setLeftVersionId(stored.document.snapshots[0].id);
        }
      }
    } catch {
      setApiMessage('离线草稿损坏，已载入模拟数据');
    }
    setHydrated(true);
    setOnline(navigator.onLine);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [hydrated, workspace]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    setPendingAnchor({
      id: selectedSentence?.id ?? selectedChapter?.id ?? '',
      type: selectedSentence ? 'sentence' : 'chapter',
      preview: selectedSentence?.text ?? selectedChapter?.title ?? ''
    });
  }, [selectedChapter?.id, selectedSentence?.id]);

  const moveToNextAnnotation = useCallback(() => {
    if (!document.annotations.length) return;
    const currentIndex = document.annotations.findIndex((item) => item.id === workspace.selectedAnnotationId);
    const next = document.annotations[(currentIndex + 1) % document.annotations.length];
    dispatch({ type: 'selectAnnotation', annotationId: next.id });
    for (const chapter of document.chapters) {
      const sentence = chapter.sentences.find((item) => item.id === next.anchorId);
      if (sentence) {
        dispatch({ type: 'selectSentence', chapterId: chapter.id, sentenceId: sentence.id });
        break;
      }
      const wordSentence = chapter.sentences.find((item) => item.tokens.some((token) => token.id === next.anchorId));
      if (wordSentence) {
        dispatch({ type: 'selectSentence', chapterId: chapter.id, sentenceId: wordSentence.id });
        break;
      }
    }
  }, [document, workspace.selectedAnnotationId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void persistSnapshot('快捷键保存');
        return;
      }
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (typing) return;
      if (event.key === '/') {
        event.preventDefault();
        window.document.getElementById('global-search-input')?.focus();
      } else if (event.key.toLowerCase() === 'j') {
        moveToNextAnnotation();
      } else if (event.key.toLowerCase() === 'k') {
        if (!document.annotations.length) return;
        const currentIndex = document.annotations.findIndex((item) => item.id === workspace.selectedAnnotationId);
        const previous = document.annotations[(currentIndex - 1 + document.annotations.length) % document.annotations.length];
        dispatch({ type: 'selectAnnotation', annotationId: previous.id });
      } else if (event.altKey && ['1', '2', '3'].includes(event.key)) {
        const mode = ({ '1': 'reading', '2': 'editing', '3': 'critical' } as const)[event.key as '1' | '2' | '3'];
        dispatch({ type: 'setMode', mode });
      } else if (event.key === ']') {
        const next = selectedSentence ? nextSentence(document, selectedSentence.id) : null;
        if (next) dispatch({ type: 'selectSentence', ...next });
      } else if (event.key === '[') {
        const previous = selectedSentence ? previousSentence(document, selectedSentence.id) : null;
        if (previous) dispatch({ type: 'selectSentence', ...previous });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [document, moveToNextAnnotation, selectedSentence, workspace.selectedAnnotationId]);

  async function persistSnapshot(reason: string) {
    setApiMessage('正在调用模拟保存接口…');
    await new Promise((resolve) => window.setTimeout(resolve, 380));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    setApiMessage(`${reason}已写入本地，模拟接口返回 200`);
    setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  }

  function addAnnotation(values: Omit<Annotation, 'id' | 'status' | 'conflictState' | 'updatedAt'>) {
    const id = `annotation-${Date.now().toString(36)}`;
    dispatch({
      type: 'commit',
      label: '新增注释',
      mutate: (doc) => {
        doc.annotations.push({
          ...values,
          id,
          status: 'open',
          conflictState: 'open',
          updatedAt: new Date().toISOString()
        });
      }
    });
    dispatch({ type: 'selectAnnotation', annotationId: id });
    setRightTab('annotations');
  }

  function updateAnnotation(id: string, patch: Partial<Annotation>) {
    dispatch({
      type: 'commit',
      label: '编辑注释',
      mutate: (doc) => {
        const annotation = doc.annotations.find((item) => item.id === id);
        if (!annotation) return;
        Object.assign(annotation, patch, { updatedAt: new Date().toISOString() });
      }
    });
  }

  function deleteAnnotation(id: string) {
    if (!window.confirm('删除该注释？引用它的注释会自动移除该引用，正文引用关系不会悬空。')) return;
    dispatch({
      type: 'commit',
      label: '删除注释并清理引用',
      mutate: (doc) => {
        doc.annotations = doc.annotations.filter((annotation) => annotation.id !== id);
        removeAnnotationReferences(doc, id);
      }
    });
  }

  function resolveConflict(group: ConflictGroup, winnerId: string, mergeBodies = false) {
    dispatch({
      type: 'commit',
      label: mergeBodies ? '合并冲突来源' : '按来源解决冲突',
      mutate: (doc) => {
        const winner = doc.annotations.find((annotation) => annotation.id === winnerId);
        if (!winner) return;
        for (const item of doc.annotations) {
          if (item.anchorId !== group.anchorId || item.kind !== group.kind) continue;
          item.conflictState = 'resolved';
          item.conflictResolution = `${new Date().toISOString()} · 选用 ${winner.source}`;
        }
        if (mergeBodies) {
          winner.body = group.annotations.map((item) => `【${item.source}】${item.body}`).join('\n\n');
        }
      }
    });
  }

  function applySentenceEdit() {
    if (!editingSentenceId || !editingSentenceDraft.trim()) return;
    let remapped = 0;
    dispatch({
      type: 'commit',
      label: '修订句子并保持引用稳定',
      mutate: (doc) => {
        remapped = updateSentenceText(doc, editingSentenceId, editingSentenceDraft.trim(), tokenizeText);
      }
    });
    setEditingSentenceId(null);
    if (remapped) setApiMessage(`已修订句子；${remapped} 条词级引用自动迁移到所属句`);
  }

  function saveVersion() {
    const label = snapshotLabel.trim() || `校订快照 ${document.snapshots.length + 1}`;
    const id = `snapshot-${Date.now().toString(36)}`;
    dispatch({
      type: 'commit',
      label: `保存版本：${label}`,
      mutate: (doc) => {
        doc.snapshots.push({
          id,
          label,
          note: `由编辑版保存，共 ${doc.annotations.length} 条注释`,
          createdAt: new Date().toISOString(),
          chapters: clone(doc.chapters),
          annotations: clone(doc.annotations)
        });
      }
    });
    setSnapshotLabel('');
    setLeftVersionId(id);
  }

  /**
   * 恢复旧快照分两步：先只生成恢复清单（不写入），列出将采用旧稿的句子、
   * 将保留的新注释/修订、将迁移的词级引用；若存在阻断冲突则停在预览。
   */
  function requestRestoreVersion(versionId: string) {
    const plan = planRestore(document, versionId);
    if (!plan) return;
    setRestorePlan(plan);
    setApiMessage(
      plan.blockingConflicts.length
        ? `恢复清单已生成，但发现 ${plan.blockingConflicts.length} 组冲突在快照之后出现新来源，已暂停写入`
        : `已生成“${plan.snapshotLabel}”的恢复清单，确认后才会写入`
    );
  }

  function closeRestorePreview() {
    setRestorePlan(null);
  }

  function confirmRestore() {
    if (!restorePlan) return;
    // 确认前按最新草稿重新核算，避免预览后又发生编辑。
    const fresh = planRestore(document, restorePlan.snapshotId);
    if (!fresh) return;
    if (fresh.blockingConflicts.length) {
      setRestorePlan(fresh);
      setApiMessage(`仍有 ${fresh.blockingConflicts.length} 组冲突待处理，未写入任何句子或注释`);
      return;
    }
    const plan = fresh;
    dispatch({
      type: 'commit',
      label: `恢复版本：${plan.snapshotLabel}（保留后补内容）`,
      mutate: (doc) => {
        applyRestorePlan(doc, plan);
      }
    });
    setApiMessage(
      `已恢复“${plan.snapshotLabel}”：${plan.revertSentences.length} 句采用旧稿，保留 ${plan.newAnnotations.length} 条新注释` +
        `${plan.migrations.length ? `，${plan.migrations.length} 条词级引用迁至所属句` : ''}`
    );
    setRestorePlan(null);
  }

  function jumpToBlockingConflict(anchorId: string) {
    for (const chapter of document.chapters) {
      const sentence = chapter.sentences.find(
        (item) => item.id === anchorId || item.tokens.some((token) => token.id === anchorId)
      );
      if (sentence) {
        dispatch({ type: 'selectSentence', chapterId: chapter.id, sentenceId: sentence.id });
        break;
      }
    }
    setRightTab('conflicts');
  }

  const comparison = useMemo(() => {
    const left = document.snapshots.find((item) => item.id === leftVersionId) ?? document.snapshots[0];
    const right =
      rightVersionId === 'current'
        ? { chapters: document.chapters, annotations: document.annotations, label: '当前草稿' }
        : document.snapshots.find((item) => item.id === rightVersionId);
    if (!left || !right) return { left: null, right: null, changes: [] as { id: string; label: string; detail: string }[] };

    const changes: { id: string; label: string; detail: string }[] = [];
    const leftSentences = new Map(
      left.chapters.flatMap((chapter) => chapter.sentences.map((sentence) => [sentence.id, { chapter, sentence }] as const))
    );
    for (const chapter of right.chapters) {
      for (const sentence of chapter.sentences) {
        const previous = leftSentences.get(sentence.id);
        if (!previous) {
          changes.push({ id: sentence.id, label: `${chapter.title} · 新增句`, detail: sentence.text });
        } else if (previous.sentence.text !== sentence.text) {
          changes.push({
            id: sentence.id,
            label: `${chapter.title} · 正文有改动`,
            detail: `${previous.sentence.text} → ${sentence.text}`
          });
        }
      }
    }
    const leftAnnotationIds = new Set(left.annotations.map((item) => item.id));
    for (const annotation of right.annotations) {
      if (!leftAnnotationIds.has(annotation.id)) {
        changes.push({ id: annotation.id, label: `新增注释 · ${annotation.title}`, detail: annotation.body });
      }
    }
    return { left, right, changes };
  }, [document, leftVersionId, rightVersionId]);

  function exportJson() {
    download(`${document.title}.json`, JSON.stringify(document, null, 2), 'application/json;charset=utf-8');
  }

  function exportHtml() {
    download(`${document.title}.html`, buildHtml(document), 'text/html;charset=utf-8');
  }

  const mode = workspace.mode;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-stone-50/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-[250px] items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-stone-900 text-amber-300 shadow-sm">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-serif text-lg font-bold tracking-wide text-stone-900">稽古堂 · 公版文本注释版</h1>
              <p className="text-[11px] text-stone-500">{document.title} · {document.edition}</p>
            </div>
          </div>

          <Tabs
            aria-label="编辑视图"
            selectedKey={mode}
            onSelectionChange={(key) => dispatch({ type: 'setMode', mode: key as ViewMode })}
            size="sm"
            className="mx-auto"
          >
            {(Object.keys(MODE_COPY) as ViewMode[]).map((item) => (
              <Tab key={item} title={MODE_COPY[item].label} />
            ))}
          </Tabs>

          <div className="ml-auto flex items-center gap-2">
            <Chip
              size="sm"
              variant="flat"
              color={online ? 'success' : 'warning'}
              startContent={online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            >
              {online ? '在线' : '离线可用'}
            </Chip>
            <Chip size="sm" variant="flat" color={workspace.dirty ? 'warning' : 'default'}>
              {workspace.dirty ? '草稿待同步' : savedAt ? `本地已存 ${savedAt}` : '离线草稿'}
            </Chip>
            <Tooltip content="撤销 ⌘/Ctrl + Z">
              <Button isIconOnly size="sm" variant="flat" aria-label="撤销" isDisabled={!state.past.length} onPress={() => dispatch({ type: 'undo' })}>
                <Undo2 className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip content="重做 ⌘/Ctrl + Shift + Z">
              <Button isIconOnly size="sm" variant="flat" aria-label="重做" isDisabled={!state.future.length} onPress={() => dispatch({ type: 'redo' })}>
                <Redo2 className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip content="保存到模拟接口 ⌘/Ctrl + S">
              <Button size="sm" color="primary" startContent={<Save className="h-4 w-4" />} onPress={() => void persistSnapshot('手动保存')}>
                保存
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1800px] items-center gap-2 px-4 pb-2 text-xs text-stone-500 lg:px-6">
          <CircleHelp className="h-3.5 w-3.5" />
          <span>{MODE_COPY[mode].hint}</span>
          <span className="ml-auto hidden items-center gap-2 md:flex">
            <Kbd>J</Kbd><span>下一条注释</span>
            <Kbd>K</Kbd><span>上一条</span>
            <Kbd>[</Kbd><span>上一句</span>
            <Kbd>]</Kbd><span>下一句</span>
            <Kbd>/</Kbd><span>搜索</span>
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1800px] grid-cols-1 gap-4 p-4 lg:grid-cols-[270px_minmax(0,1fr)_390px] lg:p-6">
        <aside className="space-y-4 no-print">
          <Card shadow="sm" className="border border-stone-200">
            <CardBody className="gap-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-semibold text-stone-900"><Search className="h-4 w-4" />全文检索</h2>
                <Chip size="sm" variant="flat">{searchResults.length} 项</Chip>
              </div>
              <Input
                id="global-search-input"
                ref={searchRef}
                aria-label="全文搜索"
                placeholder="正文、注释、来源…"
                value={workspace.query}
                onValueChange={(query) => dispatch({ type: 'setQuery', query })}
                startContent={<Search className="h-4 w-4 text-stone-400" />}
              />
              {workspace.query ? (
                <ScrollShadow className="max-h-56">
                  <div className="space-y-2 pr-1">
                    {searchResults.map((result) => (
                      <button
                        key={`${result.kind}-${result.annotationId ?? result.sentenceId ?? result.chapterId}`}
                        type="button"
                        className="w-full rounded-lg border border-stone-200 bg-white p-2 text-left hover:border-amber-400 hover:bg-amber-50"
                        onClick={() => {
                          if (result.annotationId) dispatch({ type: 'selectAnnotation', annotationId: result.annotationId });
                          if (result.sentenceId) {
                            dispatch({ type: 'selectSentence', chapterId: result.chapterId, sentenceId: result.sentenceId });
                          } else {
                            dispatch({ type: 'selectChapter', chapterId: result.chapterId });
                          }
                          setPendingAnchor(null);
                        }}
                      >
                        <div className="text-xs font-semibold text-stone-800">{result.title}</div>
                        <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-500">{result.excerpt}</div>
                      </button>
                    ))}
                    {!searchResults.length ? <p className="p-2 text-xs text-stone-500">没有匹配内容。</p> : null}
                  </div>
                </ScrollShadow>
              ) : null}
            </CardBody>
          </Card>

          <Card shadow="sm" className="border border-stone-200">
            <CardHeader className="px-4 pb-0 pt-4">
              <h2 className="flex items-center gap-2 font-semibold text-stone-900"><ListTree className="h-4 w-4" />目录</h2>
            </CardHeader>
            <CardBody className="gap-2 p-3">
              {document.chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  className={`rounded-xl border p-3 text-left transition ${
                    chapter.id === selectedChapter?.id
                      ? 'border-amber-400 bg-amber-50'
                      : 'border-transparent hover:border-stone-200 hover:bg-stone-50'
                  }`}
                  onClick={() => {
                    dispatch({ type: 'selectChapter', chapterId: chapter.id });
                    setPendingAnchor(null);
                  }}
                >
                  <div className="flex items-center">
                    <span className="mr-2 grid h-6 w-6 place-items-center rounded-full bg-stone-900 text-[11px] text-white">
                      {chapter.order}
                    </span>
                    <span className="font-medium text-stone-900">{chapter.title}</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-stone-400" />
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-500">{chapter.summary}</p>
                </button>
              ))}
            </CardBody>
          </Card>

          <Card shadow="none" className="border border-dashed border-stone-300 bg-stone-50/70">
            <CardBody className="gap-2 p-4 text-xs text-stone-600">
              <div className="flex items-center gap-2 font-semibold text-stone-800"><Keyboard className="h-4 w-4" />键盘工作流</div>
              <p><Kbd>⌘/Ctrl S</Kbd> 模拟接口保存</p>
              <p><Kbd>Alt 1/2/3</Kbd> 切换阅读、编辑、校勘版</p>
              <p><Kbd>J / K</Kbd> 在全部注释间移动</p>
              <p>最后操作：{state.lastAction}</p>
            </CardBody>
          </Card>
        </aside>

        <section className="min-w-0">
          <Card shadow="sm" className="paper-texture border border-stone-200">
            <CardHeader className="flex-col items-start gap-2 px-6 pb-2 pt-6 sm:flex-row sm:items-end">
              <div>
                <div className="text-xs uppercase tracking-[0.24em] text-amber-700">Chapter {selectedChapter?.order}</div>
                <h2 className="mt-1 font-serif text-3xl font-bold text-stone-900">{selectedChapter?.title}</h2>
                <p className="mt-1 text-sm text-stone-500">{selectedChapter?.summary}</p>
              </div>
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                <Chip variant="flat" color="warning">{conflicts.length} 处待解冲突</Chip>
                <Chip variant="flat">{document.annotations.length} 条注释</Chip>
                <Button size="sm" variant="flat" startContent={<Printer className="h-4 w-4" />} onPress={() => window.print()}>
                  打印
                </Button>
              </div>
            </CardHeader>
            <Divider />
            <CardBody className="px-5 py-7 sm:px-9">
              <div className="mx-auto max-w-4xl space-y-5">
                {selectedChapter?.sentences.map((sentence) => {
                  const sentenceAnnotations = document.annotations.filter(
                    (annotation) =>
                      annotation.anchorId === sentence.id ||
                      sentence.tokens.some((token) => token.id === annotation.anchorId)
                  );
                  const active = selectedSentence?.id === sentence.id;
                  return (
                    <article
                      key={sentence.id}
                      id={sentence.id}
                      tabIndex={0}
                      aria-label={`${selectedChapter.title}第${sentence.order}句，${sentenceAnnotationCount(document, sentence)}条注释`}
                      className={`group rounded-2xl border p-4 transition focus-ring ${
                        active ? 'border-amber-300 bg-white shadow-sm' : 'border-transparent hover:border-stone-200 hover:bg-white/70'
                      }`}
                      onClick={() => dispatch({ type: 'selectSentence', chapterId: selectedChapter.id, sentenceId: sentence.id })}
                    >
                      <div className="flex gap-3">
                        <span className="w-7 shrink-0 pt-1 text-right font-serif text-sm text-stone-400">{sentence.order}</span>
                        <div className="min-w-0 flex-1">
                          {editingSentenceId === sentence.id ? (
                            <div className="space-y-3">
                              <Textarea
                                aria-label="编辑句子正文"
                                value={editingSentenceDraft}
                                onValueChange={setEditingSentenceDraft}
                                minRows={2}
                                autoFocus
                              />
                              <div className="flex gap-2">
                                <Button size="sm" color="primary" onPress={applySentenceEdit}>保存修订</Button>
                                <Button size="sm" variant="light" onPress={() => setEditingSentenceId(null)}>取消</Button>
                              </div>
                            </div>
                          ) : (
                            <p className="font-serif text-xl leading-[2.1] text-stone-850">
                              {sentence.tokens.map((token) => {
                                const tokenAnnotations = document.annotations.filter((annotation) => annotation.anchorId === token.id);
                                if (!token.text.trim()) return <span key={token.id}>{token.text}</span>;
                                return (
                                  <button
                                    key={token.id}
                                    type="button"
                                    className={`focus-ring rounded ${tokenAnnotations.length ? 'annotation-anchor' : 'hover:bg-amber-50'}`}
                                    aria-label={`${token.text}，${tokenAnnotations.length}条词语注释`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setPendingAnchor({ id: token.id, type: 'word', preview: token.text });
                                      dispatch({ type: 'selectSentence', chapterId: selectedChapter.id, sentenceId: sentence.id });
                                      if (tokenAnnotations[0]) dispatch({ type: 'selectAnnotation', annotationId: tokenAnnotations[0].id });
                                    }}
                                  >
                                    {token.text}
                                    {tokenAnnotations.length ? <sup className="ml-0.5 text-[10px] text-orange-700">{tokenAnnotations.length}</sup> : null}
                                  </button>
                                );
                              })}
                            </p>
                          )}

                          {mode === 'critical' ? (
                            <div className="mt-3 grid gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-3 sm:grid-cols-2">
                              {sentenceAnnotations.length ? sentenceAnnotations.map((annotation) => (
                                <div key={annotation.id} className="critical-variant text-xs leading-5">
                                  <div className="flex items-center gap-2">
                                    <Chip size="sm" color={kindColors[annotation.kind]} variant="flat">{kindLabel(annotation.kind)}</Chip>
                                    <b>{annotation.source}</b>
                                  </div>
                                  <p className="mt-1 text-stone-700">{annotation.body}</p>
                                </div>
                              )) : <p className="text-xs text-stone-500">本句尚无来源异文或校记。</p>}
                            </div>
                          ) : null}

                          {mode !== 'critical' && sentenceAnnotations.length ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {sentenceAnnotations.map((annotation, index) => (
                                <button
                                  key={annotation.id}
                                  type="button"
                                  className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] text-stone-600 hover:border-amber-400 hover:text-amber-800"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    dispatch({ type: 'selectAnnotation', annotationId: annotation.id });
                                  }}
                                >
                                  [{index + 1}] {annotation.source} · {kindLabel(annotation.kind)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {mode === 'editing' ? (
                          <Tooltip content="编辑正文，词级引用会自动迁移">
                            <Button
                              isIconOnly
                              size="sm"
                              variant="light"
                              aria-label="编辑句子"
                              onPress={() => {
                                setEditingSentenceId(sentence.id);
                                setEditingSentenceDraft(sentence.text);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </Tooltip>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        </section>

        <aside className="min-w-0 no-print">
          <Card shadow="sm" className="sticky top-[106px] max-h-[calc(100vh-124px)] border border-stone-200">
            <CardBody className="p-0">
              <Tabs
                aria-label="校对面板"
                fullWidth
                selectedKey={rightTab}
                onSelectionChange={(key) => setRightTab(String(key))}
                classNames={{ tabList: 'px-3 pt-2', panel: 'p-4' }}
              >
                <Tab key="annotations" title="注释">
                  <ScrollShadow className="max-h-[calc(100vh-210px)]">
                    <div className="space-y-4 pr-1">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">当前编辑目标</div>
                        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
                          <Chip size="sm" variant="flat" color="warning">{anchorTypeLabels[anchor.type]}</Chip>
                          <p className="mt-2 line-clamp-2 font-serif text-sm leading-6 text-stone-800">{anchor.preview}</p>
                        </div>
                      </div>

                      <AnnotationForm
                        anchorId={anchor.id}
                        anchorType={anchor.type}
                        anchorPreview={anchor.preview.slice(0, 42)}
                        onSubmit={addAnnotation}
                      />

                      <Divider />

                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-stone-900">此目标注释</h3>
                        <Chip size="sm" variant="flat">{anchorAnnotations.length} 条</Chip>
                      </div>
                      {anchorAnnotations.length ? anchorAnnotations.map((annotation) => (
                        <AnnotationCard
                          key={annotation.id}
                          annotation={annotation}
                          document={document}
                          selected={selectedAnnotation?.id === annotation.id}
                          onSelect={() => dispatch({ type: 'selectAnnotation', annotationId: annotation.id })}
                          onUpdate={(patch) => updateAnnotation(annotation.id, patch)}
                          onDelete={() => deleteAnnotation(annotation.id)}
                        />
                      )) : <p className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-xs text-stone-500">尚未添加注释。选择词语可缩小注释范围。</p>}
                    </div>
                  </ScrollShadow>
                </Tab>

                <Tab key="conflicts" title={`冲突 ${conflicts.length}`}>
                  <ScrollShadow className="max-h-[calc(100vh-210px)]">
                    <div className="space-y-4 pr-1">
                      <div className="rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-800">
                        系统按“相同引用目标 + 相同注释类型”识别来源冲突。可逐条保留、合并或标记解决，正文引用 ID 不变。
                      </div>
                      {conflicts.map((group) => (
                        <Card key={group.key} shadow="none" className="border border-red-100">
                          <CardBody className="gap-3 p-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <Chip size="sm" color="danger" variant="flat">{kindLabel(group.kind)}</Chip>
                                <span className="text-xs text-stone-500">{group.annotations.length} 个来源</span>
                              </div>
                              <p className="mt-2 line-clamp-2 font-serif text-sm text-stone-800">{group.anchorLabel}</p>
                            </div>
                            {group.annotations.map((annotation) => (
                              <div key={annotation.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <b className="text-sm text-stone-900">{annotation.source}</b>
                                  <Chip size="sm" variant="flat">{annotation.title}</Chip>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-stone-600">{annotation.body}</p>
                                <div className="mt-2 flex gap-2">
                                  <Button size="sm" color="primary" variant="flat" onPress={() => resolveConflict(group, annotation.id)}>选用此条</Button>
                                  <Button size="sm" variant="light" onPress={() => resolveConflict(group, annotation.id, true)}>合并条文</Button>
                                </div>
                              </div>
                            ))}
                          </CardBody>
                        </Card>
                      ))}
                      {!conflicts.length ? (
                        <div className="grid place-items-center rounded-xl border border-dashed border-green-200 bg-green-50 p-8 text-center">
                          <Check className="h-8 w-8 text-green-600" />
                          <p className="mt-2 text-sm font-medium text-green-800">所有来源冲突均已解决</p>
                          <p className="mt-1 text-xs text-green-700">已解决记录仍保留在各注释的来源字段中。</p>
                        </div>
                      ) : null}
                    </div>
                  </ScrollShadow>
                </Tab>

                <Tab key="versions" title="版本">
                  <ScrollShadow className="max-h-[calc(100vh-210px)]">
                    <div className="space-y-4 pr-1">
                      {restorePlan ? (
                        <Card shadow="none" className="border-2 border-amber-300 bg-amber-50/60">
                          <CardHeader className="px-4 pb-0 pt-4">
                            <div className="flex w-full items-start gap-2">
                              <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                              <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-stone-900">
                                  恢复清单 · {restorePlan.snapshotLabel}
                                </h3>
                                <p className="mt-0.5 text-[11px] text-stone-500">
                                  快照保存于 {new Date(restorePlan.snapshotCreatedAt).toLocaleString('zh-CN')} ·
                                  当前仅为预览，尚未写入
                                </p>
                              </div>
                              <Button
                                isIconOnly
                                size="sm"
                                variant="light"
                                aria-label="关闭恢复清单"
                                onPress={closeRestorePreview}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          </CardHeader>
                          <CardBody className="gap-4 px-4 py-3">
                            {restorePlan.blockingConflicts.length ? (
                              <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                                <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
                                  <AlertTriangle className="h-4 w-4" />
                                  {restorePlan.blockingConflicts.length} 组冲突在旧快照中已解决，当前又出现新来源
                                </div>
                                <p className="text-xs leading-5 text-red-700">
                                  请先在「冲突」页处理以下冲突，再重新生成恢复清单；确认不会写入任何句子或注释。
                                </p>
                                {restorePlan.blockingConflicts.map((conflict) => (
                                  <div key={conflict.key} className="rounded-lg border border-red-200 bg-white p-2.5 text-xs">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Chip size="sm" color="danger" variant="flat">{kindLabel(conflict.kind)}</Chip>
                                      <span className="font-semibold text-stone-800">{conflict.anchorLabel}</span>
                                    </div>
                                    <div className="mt-1.5 space-y-1">
                                      <p className="text-stone-600">
                                        快照中已选用：
                                        {conflict.resolved.map((item) => ` ${item.source}`).join('；')}
                                      </p>
                                      <p className="font-medium text-red-700">
                                        新来源：
                                        {conflict.incoming.map((item) => ` ${item.source}（${item.title}）`).join('；')}
                                      </p>
                                    </div>
                                    {conflicts.some((group) => group.anchorId === conflict.anchorId && group.kind === conflict.kind) ? (
                                      <Button
                                        size="sm"
                                        color="danger"
                                        variant="flat"
                                        className="mt-2"
                                        onPress={() => jumpToBlockingConflict(conflict.anchorId)}
                                      >
                                        前往冲突页处理
                                      </Button>
                                    ) : (
                                      <p className="mt-2 text-[11px] text-stone-500">
                                        相关注释均已标记解决；若仍要恢复，请先在注释面板调整状态。
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : null}

                            <RestorePreviewSection
                              title={`采用旧稿的句子（${restorePlan.revertSentences.length}）`}
                              tone="revert"
                              emptyText="没有句子将被旧稿覆盖。"
                              items={restorePlan.revertSentences.map((item) => ({
                                key: item.sentenceId,
                                heading: `${item.chapterTitle} · 第 ${item.order} 句`,
                                from: item.currentText,
                                to: item.snapshotText
                              }))}
                            />
                            <RestorePreviewSection
                              title={`随旧稿恢复的句子（${restorePlan.restoredSentences.length}）`}
                              tone="revert"
                              emptyText="旧稿中的句子当前均存在。"
                              items={restorePlan.restoredSentences.map((item) => ({
                                key: item.sentenceId,
                                heading: `${item.chapterTitle} · 第 ${item.order} 句`,
                                to: item.snapshotText
                              }))}
                            />
                            <RestorePreviewSection
                              title={`保留的新句子（${restorePlan.keptSentences.length}）`}
                              tone="keep"
                              emptyText="快照之后没有新增句子。"
                              items={restorePlan.keptSentences.map((item) => ({
                                key: item.sentenceId,
                                heading: `${item.chapterTitle} · 第 ${item.order} 句`,
                                to: item.currentText
                              }))}
                            />

                            <div className="rounded-xl border border-stone-200 bg-white p-3">
                              <h4 className="text-xs font-semibold text-stone-800">
                                保留的新注释（{restorePlan.newAnnotations.length}）与修订
                                （{restorePlan.revisedAnnotations.length}）
                              </h4>
                              <p className="mt-1 text-[11px] text-stone-500">
                                快照之后补写的注释和编辑一律保留当前版本；另有 {restorePlan.unchangedAnnotationCount} 条与旧稿一致，不重复列出。
                              </p>
                              <ul className="mt-2 space-y-1.5">
                                {restorePlan.newAnnotations.map((annotation) => (
                                  <li key={annotation.id} className="text-xs leading-5 text-stone-700">
                                    <Chip size="sm" color="success" variant="flat" className="mr-1.5">新增</Chip>
                                    <b>{annotation.title}</b>
                                    <span className="text-stone-500"> · {annotation.source} · {kindLabel(annotation.kind)}</span>
                                  </li>
                                ))}
                                {restorePlan.revisedAnnotations.map(({ annotation, changedFields }) => (
                                  <li key={annotation.id} className="text-xs leading-5 text-stone-700">
                                    <Chip size="sm" color="primary" variant="flat" className="mr-1.5">修订</Chip>
                                    <b>{annotation.title}</b>
                                    <span className="text-stone-500">
                                      {' '}· {annotation.source} · 保留字段：{changedFields.join('、')}
                                    </span>
                                  </li>
                                ))}
                                {!restorePlan.newAnnotations.length && !restorePlan.revisedAnnotations.length ? (
                                  <li className="text-[11px] text-stone-500">快照之后没有新增或修订注释。</li>
                                ) : null}
                              </ul>
                            </div>

                            <div className="rounded-xl border border-stone-200 bg-white p-3">
                              <h4 className="text-xs font-semibold text-stone-800">
                                词级引用迁移（{restorePlan.migrations.length}）
                              </h4>
                              <p className="mt-1 text-[11px] text-stone-500">
                                旧稿中相应词语已不存在，这些词级注释将改挂到所属句，引用关系不悬空。
                              </p>
                              {restorePlan.migrations.length ? (
                                <ul className="mt-2 space-y-1.5">
                                  {restorePlan.migrations.map((migration) => (
                                    <li key={migration.annotationId} className="text-xs leading-5 text-stone-700">
                                      <Chip size="sm" color="warning" variant="flat" className="mr-1.5">迁移</Chip>
                                      <b>{migration.annotationTitle}</b>
                                      <span className="text-stone-500">
                                        {' '}· “{migration.tokenText}” → {migration.sentenceLabel}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-2 text-[11px] text-stone-500">没有需要迁移的词级引用。</p>
                              )}
                            </div>

                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                color="primary"
                                isDisabled={restorePlan.blockingConflicts.length > 0}
                                startContent={<Check className="h-4 w-4" />}
                                onPress={confirmRestore}
                              >
                                按清单恢复
                              </Button>
                              <Button size="sm" variant="light" onPress={closeRestorePreview}>取消</Button>
                              {restorePlan.blockingConflicts.length ? (
                                <span className="self-center text-[11px] font-medium text-red-700">
                                  存在阻断冲突，恢复按钮已停用
                                </span>
                              ) : null}
                            </div>
                          </CardBody>
                        </Card>
                      ) : null}

                      <div className="rounded-xl border border-stone-200 p-3">
                        <h3 className="flex items-center gap-2 font-semibold text-stone-900"><GitCompareArrows className="h-4 w-4" />保存校订快照</h3>
                        <Input className="mt-3" size="sm" label="版本名称" value={snapshotLabel} onValueChange={setSnapshotLabel} placeholder="如：参校本会校后" />
                        <Button className="mt-2 w-full" size="sm" color="primary" variant="flat" onPress={saveVersion} startContent={<Save className="h-4 w-4" />}>
                          保存当前版本
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <Select
                          aria-label="左侧版本"
                          label="左侧"
                          size="sm"
                          selectedKeys={new Set([leftVersionId])}
                          onSelectionChange={(keys) => setLeftVersionId(String(Array.from(keys)[0]))}
                        >
                          {document.snapshots.map((snapshot) => <SelectItem key={snapshot.id}>{snapshot.label}</SelectItem>)}
                        </Select>
                        <Select
                          aria-label="右侧版本"
                          label="右侧"
                          size="sm"
                          selectedKeys={new Set([rightVersionId])}
                          onSelectionChange={(keys) => setRightVersionId(String(Array.from(keys)[0]))}
                        >
                          {[{ id: 'current', label: '当前草稿' }, ...document.snapshots.map((snapshot) => ({ id: snapshot.id, label: snapshot.label }))]
                            .map((option) => <SelectItem key={option.id}>{option.label}</SelectItem>)}
                        </Select>
                      </div>

                      <div className="rounded-xl border border-stone-200">
                        <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2 text-xs">
                          <span>{comparison.changes.length} 处差异</span>
                          {comparison.left ? <Button size="sm" variant="light" startContent={<ListChecks className="h-3.5 w-3.5" />} onPress={() => requestRestoreVersion(comparison.left!.id)}>恢复左侧（预览清单）</Button> : null}
                        </div>
                        <div className="max-h-72 space-y-2 overflow-y-auto p-2">
                          {comparison.changes.map((change) => (
                            <button
                              key={`${change.id}-${change.label}`}
                              type="button"
                              className="w-full rounded-lg bg-stone-50 p-2 text-left hover:bg-amber-50"
                              onClick={() => {
                                for (const chapter of document.chapters) {
                                  const sentence = chapter.sentences.find((item) => item.id === change.id);
                                  if (sentence) {
                                    dispatch({ type: 'selectSentence', chapterId: chapter.id, sentenceId: sentence.id });
                                    break;
                                  }
                                }
                              }}
                            >
                              <div className="text-xs font-semibold text-stone-800">{change.label}</div>
                              <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-500">{change.detail}</div>
                            </button>
                          ))}
                          {!comparison.changes.length ? <p className="p-4 text-center text-xs text-stone-500">两个版本没有句子或注释差异。</p> : null}
                        </div>
                      </div>

                      <Divider />
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="flat" onPress={exportHtml} startContent={<FileDown className="h-4 w-4" />}>导出 HTML</Button>
                        <Button size="sm" variant="flat" onPress={exportJson} startContent={<FileJson className="h-4 w-4" />}>导出 JSON</Button>
                      </div>
                      <p className="text-[11px] leading-5 text-stone-500">{apiMessage}</p>
                    </div>
                  </ScrollShadow>
                </Tab>
              </Tabs>
            </CardBody>
          </Card>
        </aside>
      </main>

      <footer className="mx-auto max-w-[1800px] px-6 pb-8 text-center text-xs text-stone-400">
        数据保存在当前浏览器；清除站点数据会同时删除离线草稿与版本快照。
      </footer>
    </div>
  );
}
