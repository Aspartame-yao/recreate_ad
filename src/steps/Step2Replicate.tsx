import { useEffect, useRef, useState, type Dispatch } from "react";
import { useStore, useToast, ROLE, type Action } from "../store";
import type { AppState, RefImage, Shot } from "../types";
import { ShotSplitControl } from "../components/ShotSplitControl";
import {
  analyzeShot,
  downloadMediaFile,
  videoPreviewUrl,
  generateVideoAndWait,
  refPromptForI2V,
  clampSeedanceDuration,
} from "../lib/museApi";
import { archiveTaskMedia, uploadTaskReference } from "../lib/taskApi";
import {
  buildShotGenerationPrompt,
  parseShotSkillMd,
} from "../lib/strategySkill";

const uid = () => Math.random().toString(36).slice(2, 9);
type AppDispatch = Dispatch<Action>;
type Notify = (message: string, options?: { tone?: "info" | "warn" }) => void;
const modelUrl = (ref: RefImage) =>
  ref.publicUrl || (ref.url.startsWith("http") ? ref.url : "");

async function runShotAnalysis(
  shot: Shot,
  dispatch: AppDispatch,
  toast: Notify,
) {
  if (shot.splitStatus !== "done" || !shot.shotTrimmedId) {
    toast(`${shot.no} 尚未完成原片拆分`, { tone: "warn" });
    return false;
  }
  dispatch({ type: "startShotAnalyze", id: shot.id });
  try {
    const r = await analyzeShot({
      ...(shot.originalClipUrl ? { video_url: shot.originalClipUrl } : { trimmed_id: shot.shotTrimmedId }),
      voiceover_hint: shot.voiceover,
    });
    const md = String(
      r?.choices?.[0]?.message?.content ??
        r?.data?.choices?.[0]?.message?.content ??
        "",
    ).trim();
    const hit = parseShotSkillMd(md);
    if (
      !md ||
      !hit?.visualPrompt?.trim() ||
      !hit?.motionPrompt?.trim() ||
      !hit?.negativePrompt?.trim()
    ) {
      const err =
        "分析结果缺少必要的画面或动作信息，无法用于复刻生成";
      dispatch({ type: "failShotAnalyze", id: shot.id, err, rawMd: md });
      toast(`${shot.no} 分析结果结构不完整`, { tone: "warn" });
      return false;
    }
    dispatch({
      type: "setShotAnalyzeMd",
      id: shot.id,
      md,
      prompt: buildShotGenerationPrompt(hit, shot.voiceover),
      requiresImage: hit.requiresImage,
    });
    toast(`${shot.no} 片段反推完成`);
    return true;
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 220);
    dispatch({ type: "failShotAnalyze", id: shot.id, err });
    toast(`${shot.no} 反推失败：${err}`, { tone: "warn" });
    return false;
  }
}

async function runShotGeneration(
  shot: Shot,
  state: AppState,
  dispatch: AppDispatch,
  toast: Notify,
) {
  const canGenerate =
    shot.splitStatus === "done" &&
    shot.analyzeStatus === "done" &&
    !!shot.analyzeMd &&
    !!shot.prompt.trim();
  if (!canGenerate) {
    toast(`${shot.no} 必须先完成片段反推，才能生成`, { tone: "warn" });
    return false;
  }
  const boundSubjects = state.subjects.filter(subject => shot.subjectIds.includes(subject.id));
  const refs = [...boundSubjects.flatMap(subject => subject.images), ...state.productRefs, ...shot.refs];
  const urls = [...new Set(refs.map(modelUrl).filter(Boolean))].slice(0, 9);
  if (refs.length && !urls.length) {
    toast("参考图尚未完成上传，请重新上传后再生成", { tone: "warn" });
    return false;
  }
  dispatch({ type: "genShot", id: shot.id, progress: 2, status: "running" });
  try {
    let tick = 0;
    const exactVoiceover = shot.voiceover.trim();
    const voiceoverBlock = exactVoiceover
      ? `\n\n【锁定口播原文｜禁止改写或省略】\n逐字、完整、按原顺序说出：「${exactVoiceover}」。不得同义改写、增删字句或用旁白替换。生成同步口型、环境音与贴合画面的轻量音效。`
      : "\n\n【声音】本镜头无口播，不要主动添加旁白；仅生成环境音与贴合画面的轻量音效。";
    const subjectBlock = boundSubjects.length
      ? `\n\n【锁定主体一致性】\n${boundSubjects.map(subject => `@${subject.name}（${subject.type}）：${subject.description || '按参考图保持外观一致'}${subject.voice ? `；音色：${subject.voice}` : ''}`).join('\n')}。凡提及 @主体名 都必须严格沿用对应参考图、外观与音色设定。`
      : '';
    const currentPrompt = `${urls.length ? refPromptForI2V(shot.prompt) : shot.prompt}${subjectBlock}${voiceoverBlock}`;
    const request = {
      prompt: currentPrompt,
      duration: clampSeedanceDuration(shot.genDuration),
      aspect_ratio: shot.aspectRatio,
      resolution: "720p" as const,
      sound: "on" as const,
      generate_audio: true,
      ...(urls.length ? { reference_images: urls } : {}),
    };
    const waitOptions = {
      intervalMs: 5000,
      onTick: () => {
        tick++;
        dispatch({
          type: "genShot",
          id: shot.id,
          progress: Math.min(94, 5 + tick * 6),
          status: "running",
        });
      },
    };
    let r: any;
    try {
      r = await generateVideoAndWait(request, waitOptions);
    } catch (firstError: any) {
      if (/20 分钟/.test(String(firstError?.message || ""))) throw firstError;
      toast(`${shot.no} 首次生成未完成，正在自动重试一次…`, { tone: "warn" });
      tick = 0;
      r = await generateVideoAndWait(request, waitOptions);
    }
    const remoteUrl =
      r?.data?.video_url ||
      r?.video_url ||
      r?.data?.content?.video_url ||
      r?.content?.video_url;
    const sourceVideoTaskId = r?.id || r?.task_id || r?.data?.task_id;
    if (!remoteUrl)
      throw new Error(
        "生成完成但未返回可播放的视频地址：" + JSON.stringify(r).slice(0, 200),
      );
    // 任务媒体区归档生成结果；归档异常不应把已生成的视频标记为失败。
    let savedUrl = remoteUrl;
    if (state.taskId) {
      try {
        savedUrl = (
          await archiveTaskMedia(
            state.taskId,
            remoteUrl,
            `${shot.no}-generated.mp4`,
            sourceVideoTaskId,
          )
        ).url;
      } catch (e) {
        console.warn("[archive generated video]", e);
      }
    }
    dispatch({
      type: "genShot",
      id: shot.id,
      progress: 100,
      status: "done",
      patch: {
        videoUrl: savedUrl,
        sourceVideoUrl: remoteUrl,
        sourceVideoTaskId,
        generatedDuration: shot.genDuration,
        trimStart: 0,
        trimEnd: shot.genDuration,
        generationError: undefined,
        isMock: false,
      },
    });
    toast(`${shot.no} 生成完成`);
    return true;
  } catch (e: any) {
    const generationError = String(e?.message || "未知错误").slice(0, 500);
    dispatch({
      type: "genShot",
      id: shot.id,
      progress: 0,
      status: "failed",
      patch: { generationError },
    });
    toast(`${shot.no} 生成失败：${generationError.slice(0, 160)}`, {
      tone: "warn",
    });
    return false;
  }
}

export function Step2Replicate() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const globalFileRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef(state);
  const batchControlRef = useRef({ running: false, stopped: false });
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  if (!state.analyzed || !state.strategySkill || !state.shots.length)
    return (
      <div className="rep-empty">
        <div className="rep-empty__eyebrow">REPLICATE · 等待反推结果</div>
        <div className="rep-empty__title">先在 1.0 完成整片拆镜与成片策略</div>
        <div className="rep-empty__note">
          视频复刻会读取 1.0
          的分镜时间轴，逐段反推拍法，再用反推内容生成新视频。
        </div>
        <button
          className="btn btn--primary"
          onClick={() => dispatch({ type: "goStep", step: 0 })}
        >
          ← 返回 1.0 视频反推
        </button>
      </div>
    );

  const uploadRefs = async (
    files: FileList | null,
    target: "global" | string,
  ) => {
    if (!files?.length) return;
    if (!state.taskId) {
      toast("任务正在初始化，请稍候再上传参考图", { tone: "warn" });
      return;
    }
    const room =
      target === "global"
        ? 9 - state.productRefs.length
        : 9 - (state.shots.find((s) => s.id === target)?.refs.length || 0);
    const selected = Array.from(files).slice(0, Math.max(0, room));
    if (!selected.length) {
      toast("参考图上限为 9 张", { tone: "warn" });
      return;
    }
    const uploaded: RefImage[] = [];
    for (const file of selected) {
      try {
        uploaded.push(await uploadTaskReference(state.taskId, file));
      } catch (e: any) {
        toast(
          `${file.name} 上传失败：${String(e?.message || e).slice(0, 100)}`,
          { tone: "warn" },
        );
      }
    }
    if (uploaded.length) {
      if (target === "global")
        dispatch({ type: "addProductRefs", refs: uploaded });
      else
        uploaded.forEach((ref) =>
          dispatch({ type: "addShotRef", id: target, ref }),
        );
      toast(`已上传 ${uploaded.length} 张参考图`);
    }
  };

  const analyzable = state.shots.filter(
    (s) =>
      s.splitStatus === "done" && ["idle", "failed"].includes(s.analyzeStatus),
  );
  const generatable = state.shots.filter(
    (s) =>
      s.splitStatus === "done" &&
      s.analyzeStatus === "done" &&
      !!s.analyzeMd &&
      !!s.prompt.trim() &&
      ["idle", "failed"].includes(s.status),
  );
  const runAll = async (mode: "analyze" | "generate") => {
    if (batchControlRef.current.running) return;
    const ids = (mode === "analyze" ? analyzable : generatable).map(
      (s) => s.id,
    );
    if (!ids.length) {
      toast(
        mode === "analyze" ? "没有可反推的已拆分片段" : "没有可生成的片段",
        { tone: "warn" },
      );
      return;
    }
    batchControlRef.current = { running: true, stopped: false };
    dispatch({ type: "startBatch", mode, queueIds: ids });
    let ok = 0;
    let cursor = 0;
    const worker = async () => {
      while (!batchControlRef.current.stopped) {
        const position = cursor++;
        if (position >= ids.length) return;
        const id = ids[position];
        const latest = stateRef.current;
        const shot = latest.shots.find((s) => s.id === id);
        if (!shot) continue;
        dispatch({ type: "setBatchCurrent", id });
        const done =
          mode === "analyze"
            ? await runShotAnalysis(shot, dispatch, toast)
            : await runShotGeneration(shot, latest, dispatch, toast);
        if (done) ok++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    const stopped = batchControlRef.current.stopped;
    batchControlRef.current = { running: false, stopped: false };
    dispatch({ type: "finishBatch" });
    toast(
      `${mode === "analyze" ? "一键反推" : "一键生成"}${stopped ? "已停止" : "完成"} · ${ok}/${ids.length}`,
    );
  };
  const stopBatch = () => {
    batchControlRef.current.stopped = true;
    dispatch({ type: "stopBatch" });
    toast("已停止提交后续任务；正在执行的任务会完成当前请求");
  };
  const locked = state.batch.mode !== "idle";

  return (
    <div className="rep-workspace">
      <ShotSplitControl variant="workflow" />
      <div className="rep-assets">
      <section className="subject-strip">
        <div><div className="product-ref-title">主体库</div></div>
        <div className="subject-strip__items">{state.subjects.slice(0, 6).map(subject => <button className={`subject-strip-tile ${subject.recommended ? 'is-recommended' : ''}`} key={subject.id} onClick={() => window.dispatchEvent(new Event('toushi:subjects'))}><span>{subject.images[0] ? <img src={subject.images[0].url} alt="" /> : subject.name.slice(0, 1)}</span><b>{subject.name || '未命名'}</b></button>)}<button aria-label="管理主体" className="subject-strip-add upload-square" onClick={() => window.dispatchEvent(new Event('toushi:subjects'))}>+</button></div>
      </section>
      <section className="product-ref-panel">
        <div>
          <div className="product-ref-title">通用参考图</div>

        </div>
        <div className="product-ref-list">
          {state.productRefs.map((ref) => (
            <div key={ref.id} className="product-ref">
              <img src={ref.url} alt={ref.name} />
              <button
                onClick={() =>
                  dispatch({ type: "delProductRef", refId: ref.id })
                }
              >
                ×
              </button>
            </div>
          ))}
          {state.productRefs.length < 9 && (
            <button
              aria-label="上传通用参考图" className="product-ref-add upload-square"
              onClick={() => globalFileRef.current?.click()}
            >
              +
            </button>
          )}
          <input
            ref={globalFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              uploadRefs(e.target.files, "global");
              e.target.value = "";
            }}
          />
        </div>
      </section>
      </div>
      <div className="rep-source-actions">
        <button
          className="chip"
          disabled={locked}
          onClick={() => {
            if (
              window.confirm(
                "重新上传会清空当前反推、拆镜和生成结果，是否继续？",
              )
            ) {
              dispatch({ type: "resetSource" });
              dispatch({ type: "goStep", step: 0 });
            }
          }}
        >
          重新上传视频
        </button>
      </div>
      <div className="rep-head">
        <div>
          <div className="rep-head__title">逐镜复刻</div>

        </div>
        <div className="rep-batch-actions">
          {locked && (
            <button className="chip" onClick={stopBatch}>
              停止后续任务
            </button>
          )}
          <button
            className="chip"
            onClick={() => runAll("analyze")}
            disabled={locked}
          >
            {state.batch.mode === "analyze"
              ? `反推中 ${state.batch.currentId || ""}`
              : `批量分析 ${analyzable.length}`}
          </button>
          <button
            className="btn btn--primary"
            onClick={() => runAll("generate")}
            disabled={locked}
          >
            {state.batch.mode === "generate"
              ? `生成中 ${state.batch.currentId || ""}`
              : `批量生成 ${generatable.length}`}
          </button>
          <span className="rep-head__count">{state.shots.length} 个镜头</span>
        </div>
      </div>
      {(() => {
        const shot =
          state.shots.find((s) => s.id === selectedShotId) || state.shots[0];
        return (
          <>
            <div className="rep-list rep-list--focus">
              <ReplicateShotRow
                key={shot.id}
                shot={shot}
                locked={locked}
                onUpload={(files) => uploadRefs(files, shot.id)}
                onAnalyze={() => runShotAnalysis(shot, dispatch, toast)}
                onGenerate={() =>
                  runShotGeneration(shot, state, dispatch, toast)
                }
              />
            </div>
            <div className="rep-shot-carousel">
              {state.shots.map((item, i) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedShotId(item.id)}
                  className={`rep-shot-carousel__item ${shot.id === item.id ? "is-active" : ""}`}
                >
                  <span>S{i + 1}</span>
                  <strong>{ROLE[item.role] || item.role}</strong>
                  <em>{item.range}</em>
                </button>
              ))}
            </div>
          </>
        );
      })()}
    </div>
  );
}

function ReplicateShotRow({
  shot,
  onAnalyze,
  onGenerate,
  onUpload,
  locked,
}: {
  shot: Shot;
  onAnalyze: () => Promise<boolean>;
  onGenerate: () => Promise<boolean>;
  onUpload: (files: FileList | null) => void;
  locked: boolean;
}) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showMd, setShowMd] = useState(false);
  const [showSubjects, setShowSubjects] = useState(false);
  const src = shot.originalClipUrl || (shot.shotTrimmedId ? videoPreviewUrl(shot.shotTrimmedId) : null);
  const parsed = shot.analyzeMd ? parseShotSkillMd(shot.analyzeMd) : null;
  const canAnalyze =
    !locked && shot.splitStatus === "done" && !!shot.shotTrimmedId;
  const canGenerate =
    !locked &&
    shot.splitStatus === "done" &&
    shot.analyzeStatus === "done" &&
    !!shot.analyzeMd &&
    !!shot.prompt.trim();
  const stCls =
    shot.status === "done"
      ? "st-done"
      : shot.status === "running"
        ? "st-run"
        : shot.status === "failed"
          ? "st-fail"
          : "";
  const stLabel =
    shot.status === "done"
      ? "生成完成"
      : shot.status === "running"
        ? `生成中 ${shot.progress}%`
        : shot.status === "failed"
          ? `生成失败${shot.generationError ? ` · ${shot.generationError.slice(0, 80)}` : ""}`
          : "未生成";
  const splitLabel =
    shot.splitStatus === "done"
      ? "原片已拆分"
      : shot.splitStatus === "running"
        ? "拆分中"
        : shot.splitStatus === "failed"
          ? "拆分失败"
          : "待拆分";
  const analyzeLabel =
    shot.analyzeStatus === "done"
      ? "反推完成"
      : shot.analyzeStatus === "running"
        ? "分析中…"
        : shot.analyzeStatus === "failed"
          ? "分析失败 · 重试"
          : "分析片段";
  return (
    <div className="panel rep-shot">
      <div className="rep-shot__grid">
        <div className="rep-compare">
          <div className="shot-no">
            {shot.no}{" "}
            <span className="rep-shot__range">
              {shot.range} · {shot.duration.toFixed(1)}s
            </span>
          </div>
          <div className="rep-compare-videos">
            <div>
              <span className="rep-video-label">原片段</span>
              <div
                className={`thumb-dark rep-shot__preview ${shot.aspectRatio === "16:9" ? "is-wide" : ""}`}
              >
                {src ? (
                  <video src={src} controls playsInline preload="metadata" />
                ) : (
                  <span>{splitLabel}</span>
                )}
              </div>
            </div>
            <div>
              <span className="rep-video-label">生成视频</span>
              <div
                className={`thumb-dark rep-shot__preview ${shot.aspectRatio === "16:9" ? "is-wide" : ""}`}
              >
                {shot.videoUrl ? (
                  <video
                    src={shot.videoUrl}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <span>等待生成</span>
                )}
              {shot.videoUrl && (
                <details className="player-menu"><summary aria-label="视频更多操作">⋯</summary><button
                  className="player-download"
                  onClick={() => downloadMediaFile(shot.videoUrl!, `${shot.no}.mp4`).catch(e => toast(`下载失败：${String(e?.message || e).slice(0, 120)}`, { tone: 'warn' }))}
                >
                  下载视频
                </button></details>
              )}
              </div>

            </div>
          </div>
          {shot.status === "running" && (
            <div className="prog rep-shot__progress">
              <i style={{ ["--p" as any]: shot.progress / 100 }} />
            </div>
          )}
        </div>
        <div className="rep-editor">
          <div className="rep-shot__tools">
            <span className="tag rep-role">{ROLE[shot.role] || shot.role}</span>
            <button className="chip" onClick={onAnalyze} disabled={!canAnalyze}>
              {analyzeLabel}
            </button>
            {shot.analyzeMd && (
              <button className="chip" onClick={() => setShowMd((v) => !v)}>
                {showMd ? "收起分析" : "查看分析"}
              </button>
            )}
            {parsed?.name && (
              <span className="rep-skill-name">{parsed.name}</span>
            )}
          </div>
          {shot.splitError && (
            <div className="rep-error">拆分失败：{shot.splitError}</div>
          )}
          {shot.analyzeError && (
            <div className="rep-error">片段反推失败：{shot.analyzeError}</div>
          )}
          {showMd && shot.analyzeMd && (
            <pre className="rep-md">{shot.analyzeMd}</pre>
          )}
          <section className="rep-settings" aria-label="视频设置"><span className="rep-module-title">视频设置</span>
          <div className="rep-chips" role="group" aria-label="时长"><span className="setting-label">时长</span>
            {([5, 10, 15] as const).map((d) => (
              <button
                key={d}
                disabled={locked}
                className={`chip chip-sm ${shot.genDuration === d ? "sel" : ""}`}
                onClick={() =>
                  dispatch({
                    type: "editShot",
                    id: shot.id,
                    patch: { genDuration: d },
                  })
                }
              >
                {d}s
              </button>
            ))}
          </div>
          <div className="rep-chips" role="group" aria-label="画面比例"><span className="setting-label">比例</span>
            {(["9:16", "16:9"] as const).map((ar) => (
              <button
                key={ar}
                disabled={locked}
                className={`chip chip-sm ${shot.aspectRatio === ar ? "sel" : ""}`}
                onClick={() =>
                  dispatch({
                    type: "editShot",
                    id: shot.id,
                    patch: { aspectRatio: ar },
                  })
                }
              >
                {ar}
              </button>
            ))}
          </div>
          </section>
          <section className="rep-module rep-module--visual" aria-label="画面描述">
          <label htmlFor={`prompt-${shot.id}`} className="rep-module-title">画面描述</label>
          <textarea
            id={`prompt-${shot.id}`}
            className="edt rep-prompt"
            value={shot.prompt}
            placeholder="描述画面，需要固定主体时输入 @主体名"
            onChange={(e) =>
              dispatch({
                type: "editShot",
                id: shot.id,
                patch: { prompt: e.target.value },
              })
            }
            disabled={locked}
          />
          </section>
          <section className="rep-module rep-module--subjects" aria-label="主体与参考图">
          <div className="shot-subject-row">
            <span className="prm-lb">主体 / 图片</span>
            <div className="shot-subject-chips">{state.subjects.filter(subject => shot.subjectIds.includes(subject.id)).map(subject => <button key={subject.id} className="bound-subject-tile" disabled={locked} aria-label={`移除主体 ${subject.name}`} title={subject.name + '（点击移除）'} onClick={() => {
              dispatch({ type: 'toggleShotSubject', shotId: shot.id, subjectId: subject.id })
              dispatch({ type: 'editShot', id: shot.id, patch: { prompt: shot.prompt.replace(new RegExp(`@${subject.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), '') } })
            }}><span className="bound-subject-image">{subject.images[0] ? <img src={subject.images[0].url} alt="" /> : subject.name.slice(0, 1)}</span><span className="bound-subject-name">{subject.name}</span></button>)}<button aria-label="添加主体或图片" className="rep-ref-add subject-bind-add" disabled={locked} onClick={() => setShowSubjects(v => !v)}>+</button></div>
            {showSubjects && <div className="subject-picker"><button onClick={() => { setShowSubjects(false); fileRef.current?.click() }}>上传图片</button>{state.subjects.filter(subject => !shot.subjectIds.includes(subject.id)).map(subject => <button key={subject.id} onClick={() => {
              dispatch({ type: 'toggleShotSubject', shotId: shot.id, subjectId: subject.id })
              if (!shot.prompt.includes(`@${subject.name}`)) dispatch({ type: 'editShot', id: shot.id, patch: { prompt: `@${subject.name} ${shot.prompt}` } })
              setShowSubjects(false)
            }}><span>{subject.images[0] ? <img src={subject.images[0].url} alt="" /> : subject.name.slice(0, 1)}</span><b>@{subject.name}</b><small>{subject.recommended ? '默认推荐' : subject.description.slice(0, 24)}</small></button>)}{!state.subjects.length && <button onClick={() => window.dispatchEvent(new Event('toushi:subjects'))}>去主体库添加</button>}</div>}
          </div>
          <div className="rep-ref-row">

            <div className="rep-refs">
              {shot.refs.map((r) => (
                <div key={r.id} className="rep-ref">
                  <img src={r.url} alt={r.name} />
                  <button
                    disabled={locked}
                    onClick={() =>
                      dispatch({ type: "delShotRef", id: shot.id, refId: r.id })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}

              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  onUpload(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          </section>
          <section className="rep-module rep-module--voice" aria-label="口播">
          <label htmlFor={`voice-${shot.id}`} className="rep-module-title">口播</label>
          <div className="rep-voice-row">
            <textarea
              id={`voice-${shot.id}`}
              className="edt rep-voice-input"
              value={shot.voiceover}
              placeholder="填写这段视频需要生成的口播内容"
              onChange={(e) =>
                dispatch({
                  type: "editShot",
                  id: shot.id,
                  patch: { voiceover: e.target.value },
                })
              }
              disabled={locked}
            />

          </div>
          </section>

        </div>
        <div className="rep-shot__meta">
          <span className={`st-chip ${stCls}`}>
            <span className="st-dot" />
            {stLabel}
          </span>
          <span
            className={`st-chip ${shot.splitStatus === "done" ? "st-done" : shot.splitStatus === "failed" ? "st-fail" : ""}`}
          >
            <span className="st-dot" />
            {splitLabel}
          </span>
          {shot.requiresImage && <span className="rep-mode">推荐图生视频</span>}

          <button
            className="btn btn--primary rep-generate"
            onClick={onGenerate}
            disabled={!canGenerate}
          >
            {shot.status === "done"
              ? "再生成一版"
              : shot.status === "running"
                ? "生成中…"
                : "生成视频"}
          </button>
          {!canGenerate && shot.analyzeStatus !== "running" && (
            <span className="rep-lock">先完成片段反推</span>
          )}
        </div>
      </div>
    </div>
  );
}
