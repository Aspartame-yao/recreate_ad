import { useState } from 'react'
import { ImagePlus, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useStore, useToast } from '../store'
import type { Subject, SubjectType } from '../types'
import { generateImage } from '../lib/museApi'
import { analyzeSubjectImage, archiveSubjectImage, createSubject, removeSubject, updateSubject, uploadSubjectImage } from '../lib/subjectApi'

const TYPE_LABEL: Record<SubjectType, string> = { person: '人物', product: '商品', scene: '场景', other: '其他' }
const VOICES = ['', '自然中性旁白，普通话，语速适中', '明亮亲和女声，普通话，语速稍快', '沉稳可信男声，普通话，语速适中', '活泼儿童声，普通话，语速稍快', '夸张有记忆点的卡通角色声']
const imageUrlFromResult = (result: any) => String(result?.data?.[0]?.url || result?.data?.image_url || result?.image_url || result?.url || '')

export function SubjectLibraryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore(); const toast = useToast()
  const [draft, setDraft] = useState<Subject | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [working, setWorking] = useState<'upload' | 'generate' | 'analyze' | 'save' | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<SubjectType | 'all'>('all')
  const filteredSubjects = state.subjects.filter(subject => (category === 'all' || subject.type === category) && `${subject.name} ${subject.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  if (!open) return null
  const replace = (subject: Subject) => dispatch({ type: 'setSubjects', subjects: state.subjects.some(item => item.id === subject.id) ? state.subjects.map(item => item.id === subject.id ? subject : item) : [...state.subjects, subject] })
  const add = async () => {
    try { const subject = await createSubject({ name: '', type: 'person', description: '', voice: '', imagePrompt: '', images: [], recommended: true, source: 'user' }); replace(subject); setCreatedId(subject.id); setGeneratorOpen(false); setDraft(subject) }
    catch (e: any) { toast(`创建主体失败：${String(e?.message || e)}`, { tone: 'warn' }) }
  }
  const cancel = async () => {
    if (createdId && draft?.id === createdId) { try { await removeSubject(createdId) } catch {}; dispatch({ type: 'setSubjects', subjects: state.subjects.filter(item => item.id !== createdId) }) }
    setCreatedId(null); setGeneratorOpen(false); setDraft(null)
  }
  const save = async () => {
    if (!draft?.name.trim() || !draft.type || !draft.images.length) { toast('请完成带红色 * 的必填项', { tone: 'warn' }); return }
    setWorking('save')
    try { const saved = await updateSubject(draft.id, { ...draft, name: draft.name.trim(), voice: draft.voice === '__custom' ? '' : draft.voice }); replace(saved); setDraft(null); setCreatedId(null); toast(`@${saved.name} 已保存到平台主体库`) }
    catch (e: any) { toast(`保存失败：${String(e?.message || e)}`, { tone: 'warn' }) } finally { setWorking(null) }
  }
  const upload = async (files: FileList | null) => {
    if (!draft || !files?.length) return; setWorking('upload')
    try { let next = draft; for (const file of Array.from(files).slice(0, 3 - draft.images.length)) next = await uploadSubjectImage(draft.id, file); setDraft(next); replace(next); toast('主体图片已上传') }
    catch (e: any) { toast(`上传失败：${String(e?.message || e)}`, { tone: 'warn' }) } finally { setWorking(null) }
  }
  const generate = async () => {
    if (!draft || draft.images.length >= 3) return
    if (!draft.imagePrompt.trim()) { toast('请先输入或编辑文生图描述', { tone: 'warn' }); return }
    setWorking('generate')
    try {
      await updateSubject(draft.id, { imagePrompt: draft.imagePrompt.trim() })
      const prompt = [`主体定妆参考图，纯净背景，主体完整清晰，不要文字、水印或拼图。`, `主体：${draft.name || '待命名主体'}（${TYPE_LABEL[draft.type]}）`, `特征：${draft.description}`, `要求：${draft.imagePrompt || draft.description || '商业摄影质感'}`].join('\n')
      const result = await generateImage({ model: 'doubao-seedream-5-0-260128', prompt, aspect_ratio: '1:1', size: '2048x2048', watermark: false }); const url = imageUrlFromResult(result); if (!url) throw new Error('没有返回图片地址')
      const archived = await archiveSubjectImage(draft.id, url, `subject-${draft.id}-${Date.now()}.jpg`); setDraft(archived.subject); replace(archived.subject); toast('主体图片已生成，可继续修改描述再生成')
    } catch (e: any) { toast(`生成失败：${String(e?.message || e)}`, { tone: 'warn' }) } finally { setWorking(null) }
  }
  const analyze = async () => {
    if (!draft?.images[0]) return; setWorking('analyze')
    try { const result = await analyzeSubjectImage(draft.images[0].url); setDraft({ ...draft, description: result.description || draft.description, name: draft.name || result.suggested_name || '', type: result.suggested_type || draft.type, voice: draft.voice || result.voice_hint || '' }); toast('AI 已解析主体描述') }
    catch (e: any) { toast(`AI 解析失败：${String(e?.message || e)}`, { tone: 'warn' }) } finally { setWorking(null) }
  }
  const removeImage = async (imageId: string) => {
    if (!draft) return
    try { const saved = await updateSubject(draft.id, { images: draft.images.filter(image => image.id !== imageId) }); setDraft(saved); replace(saved) }
    catch (e: any) { toast(`移除图片失败：${String(e?.message || e)}`, { tone: 'warn' }) }
  }
  const remove = async (subject: Subject) => { if (!window.confirm(`删除平台主体「${subject.name || '未命名'}」？`)) return; await removeSubject(subject.id); dispatch({ type: 'deleteSubject', id: subject.id }); if (draft?.id === subject.id) setDraft(null) }

  return <div className={`library-page subject-page ${draft ? 'is-editing' : ''}`} onClick={e => { if (e.target === e.currentTarget && !draft) onClose() }}><aside className="task-drawer subject-drawer">
    <div className="task-drawer-head"><div><div className="task-drawer-title">主体库</div></div><button className="pv-icon" aria-label="关闭主体库" onClick={onClose}><X size={17} /></button></div>
    <div className="subject-toolbar"><span>{state.subjects.length} 个平台主体</span><button className="btn btn--primary btn--sm btn-with-icon" onClick={() => void add()}><Plus size={14} />添加主体</button></div>
    <div className="library-filters"><input className="edt" aria-label="搜索主体" placeholder="搜索主体" value={query} onChange={e => setQuery(e.target.value)} /><div className="chips" role="group" aria-label="主体分类">{(['all', 'person', 'product', 'scene', 'other'] as const).map(type => <button className={`chip ${category === type ? 'sel' : ''}`} key={type} aria-pressed={category === type} onClick={() => setCategory(type)}>{type === 'all' ? '全部' : TYPE_LABEL[type]}</button>)}</div></div>
    {!!state.subjects.length && !filteredSubjects.length && <div className="subject-empty">没有匹配的主体</div>}
    {!state.subjects.length ? <div className="subject-empty"><ImagePlus size={24} /><b>还没有平台主体</b><span>上传或生成一张图片，建立第一个可复用主体。</span><button className="chip" onClick={() => void add()}>添加第一个主体</button></div> : <div className="subject-grid">{filteredSubjects.map(subject => <button className={`subject-tile ${subject.images.length ? '' : 'is-draft'}`} key={subject.id} onClick={() => { setCreatedId(null); setGeneratorOpen(false); setDraft({ ...subject }) }}><span>{subject.images[0] ? <img src={subject.images[0].url} alt={subject.name} /> : <ImagePlus size={22} />}</span><b>{subject.name || '未命名主体'}</b><small>{TYPE_LABEL[subject.type]} · {subject.images.length ? `${subject.images.length} 张` : '待补图'}</small></button>)}</div>}
  </aside>
  {draft && <div className="subject-modal-mask"><section className="subject-modal" aria-label="主体设置">
    <div className="subject-modal__head"><div><b>{createdId ? '新建主体' : `设置 @${draft.name}`}</b><span>保存后可在所有任务中复用</span></div><button className="pv-icon" aria-label="关闭主体设置" onClick={() => void cancel()}><X size={17} /></button></div>
    <div className="subject-modal__body">
      <label><span>主体图片 <em className="req">*</em><small>最多 3 张</small></span><div className="subject-images subject-images--large">{draft.images.map(image => <div className="subject-image" key={image.id}><img src={image.url} alt="" /><button type="button" aria-label="移除图片" onClick={() => void removeImage(image.id)}><X size={11} /></button></div>)}{draft.images.length < 3 && <><label className="subject-image-add upload-square" aria-label="上传主体图片"><span>+</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden disabled={!!working} onChange={e => { void upload(e.target.files); e.target.value = '' }} /></label><button type="button" className="subject-image-add" disabled={!!working} onClick={() => { setGeneratorOpen(true); if (!draft.imagePrompt.trim()) setDraft({ ...draft, imagePrompt: [draft.name, draft.description].filter(Boolean).join('，') }) }}><Sparkles size={15} /><span>{draft.images.length ? '再生图' : '文生图'}</span></button></>}</div></label>
      {generatorOpen && draft.images.length < 3 && <div className="subject-generator"><div><b>文生图描述</b><small>可修改后再生成，每次生成一张</small></div><textarea autoFocus value={draft.imagePrompt} placeholder="例：穿蓝色西装的年轻男性，正面全身，纯白背景，商业摄影" onChange={e => setDraft({ ...draft, imagePrompt: e.target.value })} /><div><button type="button" className="btn btn--ghost btn--sm" disabled={!!working} onClick={() => setGeneratorOpen(false)}>取消</button><button type="button" className="btn btn--primary btn--sm btn-with-icon" disabled={!!working || !draft.imagePrompt.trim()} onClick={() => void generate()}><Sparkles size={14} />{working === 'generate' ? '生成中…' : draft.images.length ? '根据新描述再生成' : '生成图片'}</button></div></div>}
      <div className="subject-required-grid"><label><span>主体名称 <em className="req">*</em></span><input value={draft.name} placeholder="例：益生菌小队" onChange={e => setDraft({ ...draft, name: e.target.value.slice(0, 30) })} /></label><label><span>主体类型 <em className="req">*</em></span><select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as SubjectType })}>{Object.entries(TYPE_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
      <label>主体描述 <small>非必填 · AI 解析</small><textarea value={draft.description} placeholder="可手动填写，也可上传图片后让 AI 解析" onChange={e => setDraft({ ...draft, description: e.target.value })} /><button className="chip subject-analyze" disabled={!draft.images.length || !!working} onClick={() => void analyze()}><Sparkles size={13} />{working === 'analyze' ? '解析中…' : 'AI 解析图片'}</button></label>
      <label>音色 <small>非必填</small><select value={VOICES.includes(draft.voice) ? draft.voice : '__custom'} onChange={e => setDraft({ ...draft, voice: e.target.value === '__custom' ? '__custom' : e.target.value })}>{VOICES.map((voice, i) => <option value={voice} key={i}>{voice || '不设置音色'}</option>)}<option value="__custom">自定义音色…</option></select>{draft.voice === '__custom' || !VOICES.includes(draft.voice) ? <input value={draft.voice === '__custom' ? '' : draft.voice} placeholder="输入自定义音色" onChange={e => setDraft({ ...draft, voice: e.target.value })} /> : null}</label>
      <label className="subject-recommended"><input type="checkbox" checked={draft.recommended} onChange={e => setDraft({ ...draft, recommended: e.target.checked })} />在新任务中作为推荐主体</label>
    </div>
    <div className="subject-modal__foot">{!createdId && <button className="subject-danger" onClick={() => void remove(draft)}><Trash2 size={14} />删除主体</button>}<span /><button className="btn btn--ghost" onClick={() => void cancel()}>取消</button><button className="btn btn--primary" disabled={!!working || !draft.name.trim() || !draft.type || !draft.images.length} onClick={() => void save()}>{working === 'save' ? '保存中…' : '保存主体'}</button></div>
  </section></div>}
  </div>
}
