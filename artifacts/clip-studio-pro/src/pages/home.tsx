import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { API_BASE } from "@/lib/api";
import {
  useListClips,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AppHeader } from "@/components/app-header";
import {
  Loader2,
  Zap,
  Plus,
  X,
  Youtube,
  Upload,
  FileVideo,
  MonitorPlay,
  Mic,
  ClipboardCopy,
  Check,
  Eye,
  Play,
  SendHorizonal,
  ZoomIn,
  Sparkles,
  ScrollText,
} from "lucide-react";

const MAX_CLIPS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;

const clipEntrySchema = z.object({
  mode: z.enum(["edited", "raw"]).default("edited"),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  headline: z.string().optional().default(""),
  captionsEnabled: z.boolean().default(true),
  outroEnabled: z.boolean().default(true),
  punchInEnabled: z.boolean().default(false),
  zoomMoments: z.string().optional().default(""),
  voiceoverEnabled: z.boolean().default(false),
  voiceoverHook: z.string().optional().default(""),
  // Pro 2: the "transformative" editing format.
  format: z.enum(["essay", "contrast", "narrative"]).default("essay"),
  // Pro 2: the narration script (pasted from Gemini). Spoken by Piper over the clip. Reused by
  // every format (essay / narrative / contrast).
  essayScript: z.string().optional().default(""),
  // Pro 2 multi-clip formats: the ADDITIONAL moments beyond segment 1 (which is this clip's own
  // URL + In/Out). Narrative = chapters 2..N; Contrast = Streamer B (exactly one). A blank
  // youtubeUrl reuses the top-level link (same video, different range).
  segments: z.array(z.object({
    youtubeUrl: z.string().optional().default(""),
    startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
    endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
    label: z.string().optional().default(""),
  })).optional().default([]),
}).superRefine((val, ctx) => {
  if (val.mode === "edited" && (!val.headline || val.headline.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Headline required for Edited mode", path: ["headline"] });
  }
  const toSecs = (t: string) => t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
  if (toSecs(val.endTime) <= toSecs(val.startTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "End time must be after start time", path: ["endTime"] });
  }
});

const formSchema = z.object({
  youtubeUrl: z
    .string()
    .url("Must be a valid URL")
    .regex(/(?:youtube\.com|youtu\.be)/, "Must be a YouTube URL"),
  frameStyle: z.enum(["standard", "immersive"]).default("immersive"),
  sourceChannel: z.string().optional().default(""),
  clips: z.array(clipEntrySchema).min(1),
});

type FormValues = z.infer<typeof formSchema>;

const defaultClip = {
  mode: "edited" as const,
  startTime: "00:00:00",
  endTime: "00:00:15",
  headline: "",
  captionsEnabled: true,
  outroEnabled: true,
  punchInEnabled: false,
  zoomMoments: "",
  voiceoverEnabled: false,
  voiceoverHook: "",
  format: "essay" as const,
  essayScript: "",
  segments: [] as { youtubeUrl: string; startTime: string; endTime: string; label: string }[],
};

type SourceTab = "youtube" | "local";

interface LocalForm {
  startTime: string;
  endTime: string;
  headline: string;
  mode: "edited" | "raw";
  sourceChannel: string;
  captionsEnabled: boolean;
}

function secsToHMS(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function toSecs(t: string): number {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return 0;
  return t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
}

function fmtDuration(start: string, end: string): string {
  const d = Math.max(0, toSecs(end) - toSecs(start));
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Copies text to the clipboard, working over plain HTTP too. The modern
 * navigator.clipboard API only exists in a secure context (HTTPS or localhost);
 * this app is served over http on a LAN IP, so we fall back to the legacy
 * execCommand("copy") approach via a hidden textarea.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ---------- small reusable bits ---------- */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground mb-1.5 block">
      {children}
    </Label>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; icon?: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex bg-background border border-border rounded-lg p-[3px] gap-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded-md px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
        checked
          ? "text-primary border-primary/40 bg-primary/[0.07]"
          : "text-muted-foreground border-border bg-card hover:text-foreground"
      }`}
    >
      <span
        className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
          checked ? "bg-primary border-primary" : "border-muted-foreground/50"
        }`}
      >
        {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3.5} />}
      </span>
      {label}
    </button>
  );
}

/* ---------- Pro 2: extra segments editor (narrative chapters 2..N / contrast Streamer B) ----------
   Segment 1 is always the clip's own URL + In/Out above; this edits the ADDITIONAL moments. Defined
   at module scope so its useFieldArray is stable per clip (calling the hook inside the parent's
   fields.map would violate the rules of hooks). */
function SegmentEditor({ form, index, format }: { form: any; index: number; format: "narrative" | "contrast" }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: `clips.${index}.segments` as never });
  const isContrast = format === "contrast";
  const max = isContrast ? 1 : 3; // contrast: exactly 1 extra (Streamer B); narrative: up to 3 more (4 total)
  return (
    <div className="space-y-2.5">
      {fields.map((f, si) => {
        const s = form.watch(`clips.${index}.segments.${si}`) as { startTime?: string; endTime?: string } | undefined;
        return (
          <div key={f.id} className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground">
                {isContrast ? "Streamer B" : `Moment ${si + 2}`}
              </span>
              <button
                type="button"
                onClick={() => remove(si)}
                className="w-6 h-6 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                aria-label="Remove segment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <Input
              placeholder="YouTube link (leave blank = same video as above)"
              className="text-sm bg-background font-mono"
              {...form.register(`clips.${index}.segments.${si}.youtubeUrl`)}
            />
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <div><FieldLabel>In</FieldLabel><Input placeholder="00:00:00" className="font-mono text-sm bg-background" {...form.register(`clips.${index}.segments.${si}.startTime`)} /></div>
              <div><FieldLabel>Out</FieldLabel><Input placeholder="00:00:10" className="font-mono text-sm bg-background" {...form.register(`clips.${index}.segments.${si}.endTime`)} /></div>
              <div className="font-mono text-[11px] text-primary border border-dashed border-primary/30 rounded-lg px-3 py-2.5 text-center whitespace-nowrap">
                <span className="block text-[9px] text-muted-foreground/60 uppercase tracking-[0.12em]">Len</span>
                {fmtDuration(s?.startTime ?? "00:00:00", s?.endTime ?? "00:00:00")}
              </div>
            </div>
            {!isContrast && (
              <Input
                placeholder="Label (optional) — e.g. 'the build-up'"
                className="text-sm bg-background"
                {...form.register(`clips.${index}.segments.${si}.label`)}
              />
            )}
          </div>
        );
      })}
      {fields.length < max && (
        <button
          type="button"
          onClick={() => append({ youtubeUrl: "", startTime: "00:00:00", endTime: "00:00:10", label: "" })}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-primary/40 text-primary text-[11px] font-mono uppercase tracking-[0.1em] py-2.5 hover:bg-primary/[0.06] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {isContrast ? "Add Streamer B" : "Add another moment"}
        </button>
      )}
    </div>
  );
}

/* ---------- live 9:16 preview ---------- */

function LivePreview({
  headline,
  mode,
  frameStyle,
  captions,
  voiceover,
  hook,
  handle,
}: {
  headline: string;
  mode: "edited" | "raw";
  frameStyle: "standard" | "immersive";
  captions: boolean;
  voiceover: boolean;
  hook: string;
  handle: string;
}) {
  const showHeadline = mode === "edited" && headline.trim().length > 0;
  const watermark = (handle || "@yourchannel").toUpperCase();
  // crude "karaoke" split for the caption mock
  const hookWords = (hook || "your spoken hook").trim().split(/\s+/).slice(0, 4);

  return (
    <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground flex items-center gap-2">
          <Eye className="w-3.5 h-3.5 text-primary" /> Live preview
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/50">9:16</span>
      </div>

      <div className="w-[200px] mx-auto aspect-[9/16] rounded-[22px] border border-border bg-black overflow-hidden relative shadow-[0_30px_60px_-30px_#000]">
        {/* 40px top drop to clear YouTube UI */}
        <div className="h-[7%] bg-black" />
        {/* video area */}
        <div className="absolute inset-x-0 top-[7%] bottom-0 grid place-items-center bg-gradient-to-br from-[#2a2140] via-[#101a2e] to-[#0a1420]">
          <div className="w-11 h-11 rounded-full grid place-items-center bg-white/10 backdrop-blur-sm border border-white/20">
            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
          </div>
        </div>

        {voiceover && (
          <div className="absolute left-2 top-[calc(7%+8px)] flex items-center gap-1 rounded-md bg-[#9b7bff]/85 px-1.5 py-0.5 text-[7.5px] font-mono tracking-wide text-white">
            <Mic className="w-2.5 h-2.5" /> HOOK
          </div>
        )}

        {showHeadline && (
          <div className="absolute inset-x-0 top-[11%] px-3 text-center">
            <span className="font-extrabold text-[13px] leading-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
              {headline}
            </span>
          </div>
        )}

        {mode === "edited" && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-extrabold tracking-wide text-[15px] text-white/85 drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            {watermark}
          </div>
        )}

        {captions && (
          <div className="absolute inset-x-0 bottom-[13%] px-3 text-center leading-snug">
            <span className="font-extrabold text-[13px] text-black bg-primary px-1.5 py-0.5 rounded-[5px] shadow">
              {hookWords[0] ?? "your"}
            </span>{" "}
            <span className="font-extrabold text-[13px] text-white drop-shadow-[0_2px_6px_#000]">
              {hookWords.slice(1).join(" ") || "captions"}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {[
          ["Frame", frameStyle === "immersive" ? "Immersive" : "Standard", "text-foreground"],
          ["Captions", captions ? "Karaoke ON" : "Off", captions ? "text-primary" : "text-muted-foreground"],
          ["Voiceover", voiceover ? "Hook ON" : "Off", voiceover ? "text-[#b69dff]" : "text-muted-foreground"],
        ].map(([k, v, cls]) => (
          <div key={k} className="flex items-center justify-between font-mono text-[10.5px]">
            <span className="text-muted-foreground">{k}</span>
            <span className={cls as string}>{v}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/60 leading-relaxed text-center">
        Reflects your settings live — what you see is the Short that renders.
      </p>
    </div>
  );
}

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("youtube");

  // YouTube preview player
  const [showPlayer, setShowPlayer] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);

  // Local file upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [localForm, setLocalForm] = useState<LocalForm>({
    startTime: "00:00:00",
    endTime: "00:01:00",
    headline: "",
    mode: "edited",
    sourceChannel: "",
    captionsEnabled: true,
  });
  const [localErrors, setLocalErrors] = useState<Partial<Record<keyof LocalForm | "file", string>>>({});

  // channel handle for the live preview watermark
  const [channelHandle, setChannelHandle] = useState("");
  useEffect(() => {
    fetch(`${API_BASE}/api/settings`)
      .then((r) => r.json() as Promise<{ channelHandle?: string }>)
      .then((d) => setChannelHandle(d.channelHandle ?? ""))
      .catch(() => {});
  }, []);

  // warm the clips list cache for the timeline
  useListClips({ query: { queryKey: getListClipsQueryKey() } });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      youtubeUrl: "",
      frameStyle: "immersive",
      clips: [{ ...defaultClip }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "clips",
  });

  const [, navigate] = useLocation();
  const isSubmitting = form.formState.isSubmitting;

  const youtubeUrl = form.watch("youtubeUrl");
  const videoId = useMemo(() => {
    if (!youtubeUrl) return null;
    const m = youtubeUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?v=))([^&?/]+)/
    );
    return m?.[1] ?? null;
  }, [youtubeUrl]);

  const prevVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (videoId !== prevVideoIdRef.current) {
      prevVideoIdRef.current = videoId;
      if (!videoId) setShowPlayer(false);
    }
  }, [videoId]);

  useEffect(() => {
    if (!showPlayer || !videoId) return;

    const mountPlayer = () => {
      if (!playerDivRef.current) return;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
      playerRef.current = new (window as any).YT.Player(playerDivRef.current, {
        videoId,
        playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onReady: () => setPlayerReady(true) },
      });
    };

    if ((window as any).YT?.Player) {
      mountPlayer();
    } else {
      const prev = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        mountPlayer();
        if (typeof prev === "function") prev();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      }
    }

    return () => {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
    };
  }, [showPlayer, videoId]);

  const handleSetIn = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.startTime`, secsToHMS(t));
  };

  const handleSetOut = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.endTime`, secsToHMS(t));
  };

  // Builds a ready-made prompt for the user's own Gemini app and copies it to the
  // clipboard. The server never calls any AI — the user pastes this into Gemini,
  // then pastes the returned hook line back into the voiceover text box.
  async function copyHookPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are a viral short-form video editor. ` +
      (hasUrl
        ? `Open and WATCH the exact section of the source video below, then write a hook grounded in what ACTUALLY happens in it — do not guess.\n`
        : `Write a hook for this clip (a local upload — if you cannot view the footage, base it on the title below).\n`) +
      `Write ONE punchy spoken intro hook (6-10 words), read aloud over the first few seconds ` +
      `of a YouTube Short, to stop the scroll and capture THIS clip's single most attention-grabbing moment. ` +
      `Return ONLY the hook line — no quotes, no extra text.\n\n` +
      `Context:\n` +
      (hasUrl
        ? `- Video: ${values.youtubeUrl}\n- Watch ONLY this section: ${clip.startTime} to ${clip.endTime}\n`
        : "") +
      `- Headline/title: ${clip.headline || "(none)"}\n` +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Prompt copied", description: "Paste it into your Gemini app, then paste the hook back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  // Pro 2 — Essay format. Builds a Gemini prompt that turns the clip into a transformative
  // "video essay": Gemini writes a full SPOKEN script that uses the clip as evidence for a point
  // (thesis -> evidence -> synthesis). Same human-in-the-loop pattern as the hook — the server
  // makes no AI calls; the user pastes this into Gemini and pastes the returned script back into
  // the Essay Script box, where Piper narrates the whole thing over the clip.
  async function copyEssayPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    // Natural narration runs ~2.3 words/sec; give Gemini a word budget that fits the clip so the
    // script doesn't overrun (the render caps narration at the clip's length).
    const wordBudget = Math.max(12, Math.round(dur * 2.3));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    const prompt =
      `You are a video-essay writer for a faceless YouTube Shorts channel. ` +
      (hasUrl
        ? `Open and WATCH the exact section of the source video below, then write a script grounded in what ACTUALLY happens in it — do not invent events.\n`
        : `Write a script for this clip (a local upload — if you cannot view the footage, base it on the title below).\n`) +
      `Write a single SPOKEN narration script that makes the clip "transformative": instead of just showing the moment, ` +
      `use it as EVIDENCE for a point. Structure it as three flowing parts (no headings, no labels):\n` +
      `1) THESIS HOOK — one punchy spoken claim or question that frames the point (this is also the scroll-stopping opening line).\n` +
      `2) THE EVIDENCE — narrate what the clip shows as proof of that point.\n` +
      `3) SYNTHESIS — one line explaining WHY this moment proves the point.\n\n` +
      `Rules: conversational spoken English, present tense, no stage directions, no quotes, no markdown. ` +
      `It will be read aloud by a TTS voice over the clip, so it MUST fit ~${dur}s — keep it to about ${wordBudget} words total. ` +
      `Return ONLY the script text.\n\n` +
      `Context:\n` +
      (hasUrl
        ? `- Video: ${values.youtubeUrl}\n- Watch ONLY this section: ${clip.startTime} to ${clip.endTime}\n`
        : "") +
      `- Headline/title: ${clip.headline || "(none)"}\n` +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Essay prompt copied", description: "Paste it into your Gemini app, then paste the script back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  // Pro 2 — Narrative format. Builds a Gemini prompt for a STORY narration spanning all the
  // moments (segment 1 = the clip's own URL + In/Out; the rest come from the segments editor).
  // Structure: hook -> build-up -> payload (the big reaction) -> payoff. Same human-in-the-loop
  // pattern; the user pastes the returned script into the Narrative Script box for Piper to read.
  async function copyNarrativePrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const moments = [
      { youtubeUrl: values.youtubeUrl, startTime: clip.startTime, endTime: clip.endTime, label: "" },
      ...(clip.segments ?? []),
    ];
    const totalDur = moments.reduce((acc, m) => acc + Math.max(0, toSecs(m.endTime) - toSecs(m.startTime)), 0);
    const wordBudget = Math.max(20, Math.round(totalDur * 2.3));
    const momentLines = moments
      .map((m, i) => `  ${i + 1}. ${(m.youtubeUrl || values.youtubeUrl)} @ ${m.startTime}-${m.endTime}${m.label ? ` (${m.label})` : ""}`)
      .join("\n");
    const prompt =
      `You are a story-driven video-essay writer for a faceless YouTube Shorts channel. ` +
      `These ${moments.length} clips play back-to-back as ONE video. WATCH each in order, then write a single ` +
      `SPOKEN narration that ties them into a story (this is what makes it "transformative"). ` +
      `Structure it as four flowing parts (no headings, no labels):\n` +
      `1) HOOK — a "what if" / "did you know" / bold question that opens the story and stops the scroll.\n` +
      `2) BUILD-UP — set the stage: the rivalry, the stakes, what's happening before the big moment.\n` +
      `3) PAYLOAD — narrate the climax (the big reaction) as it lands.\n` +
      `4) PAYOFF — the result/fallout: how it changed things.\n\n` +
      `Rules: conversational spoken English, present tense, no stage directions, no quotes, no markdown. ` +
      `It is read aloud over the stitched clips so it MUST fit ~${totalDur}s — keep it to about ${wordBudget} words total, ` +
      `pacing the four beats across the clips in order. Return ONLY the script text.\n\n` +
      `Clips in order:\n${momentLines}\n` +
      `Source channel: ${values.sourceChannel || "(unknown)"}`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Narrative prompt copied", description: "Paste it into your Gemini app, then paste the story script back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  // Pro 2 — Contrast format. Builds a Gemini prompt for COMPARISON narration over two streamers
  // reacting to the same moment (Streamer A = the clip's URL + In/Out; Streamer B = the one extra
  // segment). The two play side-by-side (A top, B bottom); the script contrasts their reactions.
  async function copyContrastPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const b = (clip.segments ?? [])[0];
    const aDur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const bDur = b ? Math.max(0, toSecs(b.endTime) - toSecs(b.startTime)) : aDur;
    const dur = Math.min(aDur, bDur); // side-by-side plays for the shorter of the two
    const wordBudget = Math.max(15, Math.round(dur * 2.3));
    const aUrl = values.youtubeUrl;
    const bUrl = (b && b.youtubeUrl && b.youtubeUrl.trim()) ? b.youtubeUrl.trim() : values.youtubeUrl;
    const prompt =
      `You are a meta-commentary video editor for a faceless YouTube Shorts channel. Two streamers ` +
      `react to the SAME moment and play SIDE-BY-SIDE (Streamer A on top, Streamer B on bottom). ` +
      `WATCH both, then write a single SPOKEN narration that COMPARES their reactions — this layer of ` +
      `analysis above the footage is what makes it "transformative". Structure it as three flowing ` +
      `parts (no headings, no labels):\n` +
      `1) SET UP the comparison in one line (same moment, two very different reactions).\n` +
      `2) CONTRAST them: what A focuses on vs what B focuses on, and what that reveals about each.\n` +
      `3) VERDICT: whose reaction is more insightful / telling, and why.\n\n` +
      `Rules: conversational spoken English, present tense, no stage directions, no quotes, no markdown. ` +
      `It is read aloud over the side-by-side clip so it MUST fit ~${dur}s — keep it to about ${wordBudget} words. ` +
      `Return ONLY the script text.\n\n` +
      `Streamer A (top): ${aUrl} @ ${clip.startTime}-${clip.endTime}\n` +
      `Streamer B (bottom): ${bUrl}${b ? ` @ ${b.startTime}-${b.endTime}` : " (add Streamer B's In/Out)"}\n` +
      `The shared moment / context: ${clip.headline || "(add a headline describing the moment)"}`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Contrast prompt copied", description: "Paste it into your Gemini app, then paste the comparison script back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  // Builds a Gemini prompt asking it to choose AUTO-ZOOM moments AND the best zoom TYPE
  // for each. Same human-in-the-loop pattern as the hook: server makes no AI calls — the
  // user pastes this into Gemini, then pastes the returned "second type" pairs back.
  async function copyZoomPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const hasUrl = !!(values.youtubeUrl && values.youtubeUrl.trim());
    // Give Gemini the actual video + the exact section to watch, so it picks INFORMED
    // moments instead of guessing. Returned seconds must be clip-relative (0 = section start).
    const sourceBlock = hasUrl
      ? `Open and WATCH this exact part of the source video, then base every choice on what ACTUALLY happens in it — do not guess:\n` +
        `Video: ${values.youtubeUrl}\n` +
        `Watch ONLY the section from ${clip.startTime} to ${clip.endTime} (about ${dur} seconds long)` +
        `${clip.headline ? `, titled "${clip.headline}"` : ""}` +
        `${values.sourceChannel ? `, from ${values.sourceChannel}` : ""}.\n`
      : `This is a ${dur}-second vertical clip` +
        `${clip.headline ? `, titled "${clip.headline}"` : ""}` +
        `${values.sourceChannel ? `, from ${values.sourceChannel}` : ""}. ` +
        `(It is a local upload — if you cannot view the footage, choose sensible moments from the title and typical short-form pacing.)\n`;
    const prompt =
      `You are a short-form video editor choosing AUTO-ZOOM moments for a vertical YouTube Short.\n` +
      sourceBlock +
      `Pick 4-8 moments where a zoom would add emphasis or energy — reactions, punchlines, key beats. ` +
      `For EACH moment pick the zoom TYPE that best fits that beat, from exactly these keywords:\n` +
      `- punch — quick zoom-in and out; all-purpose emphasis on a punchline or reaction\n` +
      `- whip — fast snappy zoom; a sudden shock or hype spike\n` +
      `- cut — hard cut to a tighter shot and back; sharp, abrupt emphasis\n` +
      `- pushin — slow gradual zoom-in; rising tension or an important line\n` +
      `- pullout — snap in then slow zoom-out; a reveal or "stepping back" beat\n` +
      `- kenburns — gentle zoom with a slow diagonal pan; calmer or B-roll stretches\n` +
      `Space the moments at least 1.5 seconds apart.\n` +
      `IMPORTANT — timing: give each moment as the number of seconds AFTER the start of that section ` +
      `(0 = ${clip.startTime}), a whole number between 1 and ${Math.max(1, dur - 1)}. Do NOT use the video's ` +
      `absolute timestamp.\n` +
      `Return ONLY a comma-separated list of "second type" pairs and NOTHING else, e.g.:\n` +
      `3 punch, 8 pushin, 14 kenburns, 20 whip, 27 cut`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Zoom prompt copied", description: "Paste it into Gemini, then paste the second+type pairs back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard.", variant: "destructive" });
    }
  }

  async function onSubmit(values: FormValues) {
    let successCount = 0;
    const failReasons: string[] = [];

    for (const clip of values.clips) {
      try {
        // Multi-clip formats: build the full ordered segment list. Segment 1 = this clip's own
        // URL + In/Out; the rest come from the segments editor (blank link = reuse the top link).
        const isMulti = clip.format === "narrative" || clip.format === "contrast";
        const segments = isMulti
          ? [
              { youtubeUrl: values.youtubeUrl, startTime: clip.startTime, endTime: clip.endTime, label: "" },
              ...(clip.segments ?? []).map((s) => ({
                youtubeUrl: (s.youtubeUrl && s.youtubeUrl.trim()) ? s.youtubeUrl.trim() : values.youtubeUrl,
                startTime: s.startTime,
                endTime: s.endTime,
                label: s.label ?? "",
              })),
            ]
          : undefined;
        if (isMulti && segments) {
          if (clip.format === "narrative" && segments.length < 2) {
            failReasons.push("Narrative needs at least 1 more moment (use “Add another moment”)");
            continue;
          }
          if (clip.format === "contrast" && segments.length !== 2) {
            failReasons.push("Contrast needs exactly Streamer A + Streamer B");
            continue;
          }
        }
        const r = await fetch(`${API_BASE}/api/clips`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            youtubeUrl: values.youtubeUrl,
            frameStyle: values.frameStyle,
            startTime: clip.startTime,
            endTime: clip.endTime,
            headline: clip.headline ?? "",
            mode: clip.mode,
            sourceChannel: values.sourceChannel ?? "",
            captionsEnabled: clip.captionsEnabled ?? true,
            outroEnabled: clip.outroEnabled ?? true,
            punchInEnabled: clip.punchInEnabled ?? false,
            zoomMoments: clip.zoomMoments ?? "",
            voiceoverEnabled: clip.voiceoverEnabled ?? false,
            voiceoverHook: clip.voiceoverHook ?? "",
            format: clip.format ?? "essay",
            essayScript: clip.essayScript ?? "",
            ...(segments ? { segments } : {}),
          }),
        });
        if (!r.ok) {
          let reason = "Failed";
          try { reason = ((await r.json()) as { error?: string }).error ?? reason; } catch { /* ignore */ }
          failReasons.push(reason);
        } else {
          successCount++;
        }
      } catch {
        failReasons.push("Network error");
      }
    }

    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });

    if (successCount > 0) {
      toast({
        title: successCount === 1 ? "1 clip job enqueued" : `${successCount} clip jobs enqueued`,
        description: failReasons.length > 0 ? `${failReasons.length} failed: ${failReasons[0]}` : undefined,
      });
      form.reset({
        youtubeUrl: values.youtubeUrl,
        frameStyle: values.frameStyle,
        sourceChannel: values.sourceChannel,
        clips: [{ ...defaultClip }],
      });
    } else {
      toast({ title: "All submissions failed", description: failReasons[0], variant: "destructive" });
    }
  }

  const validateLocalForm = useCallback((): boolean => {
    const errors: typeof localErrors = {};
    if (!selectedFile) errors.file = "Please select a video file";
    const startValid = !!localForm.startTime.match(/^\d{2}:\d{2}:\d{2}$/);
    const endValid = !!localForm.endTime.match(/^\d{2}:\d{2}:\d{2}$/);
    if (!startValid) errors.startTime = "Must be HH:MM:SS";
    if (!endValid) errors.endTime = "Must be HH:MM:SS";
    if (startValid && endValid) {
      if (toSecs(localForm.endTime) <= toSecs(localForm.startTime))
        errors.endTime = "End time must be after start time";
    }
    if (localForm.mode === "edited" && !localForm.headline.trim())
      errors.headline = "Headline required for Edited mode";
    setLocalErrors(errors);
    return Object.keys(errors).length === 0;
  }, [selectedFile, localForm]);

  const handleLocalUpload = useCallback(async () => {
    if (!validateLocalForm() || !selectedFile) return;
    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("startTime", localForm.startTime);
    formData.append("endTime", localForm.endTime);
    formData.append("headline", localForm.headline);
    formData.append("mode", localForm.mode);
    formData.append("frameStyle", form.getValues("frameStyle"));
    formData.append("sourceChannel", localForm.sourceChannel ?? "");
    formData.append("captionsEnabled", String(localForm.captionsEnabled));

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        setIsUploading(false);
        setUploadProgress(null);
        if (xhr.status === 201) {
          toast({ title: "File uploaded — processing started" });
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setLocalForm({ startTime: "00:00:00", endTime: "00:01:00", headline: "", mode: "edited", sourceChannel: "", captionsEnabled: true });
          setLocalErrors({});
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
        } else {
          let msg = "Upload failed";
          try { msg = (JSON.parse(xhr.responseText) as { error: string }).error || msg; } catch { /* ignore */ }
          toast({ title: msg, variant: "destructive" });
        }
        resolve();
      };
      xhr.onerror = () => {
        setIsUploading(false);
        setUploadProgress(null);
        toast({ title: "Network error — upload failed", variant: "destructive" });
        resolve();
      };
      xhr.open("POST", `${API_BASE}/api/clips/upload`);
      xhr.send(formData);
    });
  }, [selectedFile, localForm, validateLocalForm, queryClient, toast, form]);

  const clipCount = fields.length;
  const wFrame = form.watch("frameStyle");

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-8">
          {/* Page heading */}
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
            <Zap className="w-4 h-4 text-primary" /> New job definition
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight">Create a Short</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-6">
            Pick a source, mark your in/out points, and dispatch render jobs to the phone.
          </p>

          <div className="mx-auto w-full max-w-3xl">
            {/* form (live preview removed in Pro 2) */}
            <div className="min-w-0">
              {/* source + frame toolbar */}
              <div className="flex flex-wrap gap-3 mb-5">
                <Segmented
                  value={sourceTab}
                  onChange={(v) => { setSourceTab(v as SourceTab); setLocalErrors({}); }}
                  options={[
                    { value: "youtube", label: "YouTube", icon: <Youtube className="w-3.5 h-3.5" /> },
                    { value: "local", label: "Local file", icon: <Upload className="w-3.5 h-3.5" /> },
                  ]}
                />
                <Segmented
                  value={wFrame}
                  onChange={(v) => form.setValue("frameStyle", v as "standard" | "immersive")}
                  options={[
                    { value: "immersive", label: "Immersive" },
                    { value: "standard", label: "Standard" },
                  ]}
                />
              </div>

              {sourceTab === "youtube" && (
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  {/* URL + source creator card */}
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Source URL</FieldLabel>
                      <div className="flex gap-2">
                        <Input
                          placeholder="https://youtube.com/watch?v=..."
                          className="font-mono text-sm bg-background flex-1 min-w-0"
                          {...form.register("youtubeUrl")}
                        />
                        {videoId && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setShowPlayer((p) => !p)}
                            className={`font-mono text-xs tracking-wider border transition-colors shrink-0 ${
                              showPlayer
                                ? "border-primary/40 bg-primary/15 text-primary"
                                : "border-border bg-card text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <MonitorPlay className="w-4 h-4" />
                            <span className="hidden sm:inline ml-2">{showPlayer ? "HIDE" : "PREVIEW"}</span>
                          </Button>
                        )}
                      </div>
                      {form.formState.errors.youtubeUrl && (
                        <p className="text-xs text-destructive font-mono mt-1.5">{form.formState.errors.youtubeUrl.message}</p>
                      )}
                    </div>

                    {showPlayer && videoId && (
                      <div className="rounded-lg border border-border overflow-hidden bg-black">
                        <div className="aspect-video w-full relative">
                          <div ref={playerDivRef} className="w-full h-full" />
                          {!playerReady && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black">
                              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                          )}
                        </div>
                        {playerReady && (
                          <div className="border-t border-border bg-card px-3 py-2 flex flex-wrap gap-2">
                            {fields.map((_, i) => (
                              <div key={i} className="flex items-center gap-1.5">
                                {clipCount > 1 && (
                                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleSetIn(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set In
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSetOut(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set Out
                                </button>
                              </div>
                            ))}
                            <span className="text-[10px] font-mono text-muted-foreground/40 self-center ml-auto">
                              pause first, then set
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <FieldLabel>Source creator <span className="text-muted-foreground/40 normal-case">(optional)</span></FieldLabel>
                      <Input
                        placeholder="e.g. KSI, MrBeast, IShowSpeed"
                        className="font-mono text-sm bg-background"
                        {...form.register("sourceChannel")}
                      />
                    </div>
                  </div>

                  {/* clip entries */}
                  <div className="space-y-3">
                    {fields.map((field, index) => {
                      const currentMode = form.watch(`clips.${index}.mode`);
                      const isRaw = currentMode === "raw";
                      const start = form.watch(`clips.${index}.startTime`);
                      const end = form.watch(`clips.${index}.endTime`);
                      const voOn = form.watch(`clips.${index}.voiceoverEnabled`) ?? false;
                      const punchOn = form.watch(`clips.${index}.punchInEnabled`) ?? false;
                      const fmt = form.watch(`clips.${index}.format`) ?? "essay";
                      const isEssay = fmt === "essay";

                      return (
                        <div key={field.id} className="rounded-xl border border-border bg-background/40 overflow-hidden">
                          {/* clip header */}
                          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                            <span className="font-mono text-[11px] text-primary bg-primary/[0.08] border border-primary/20 w-7 h-7 rounded-md grid place-items-center font-semibold tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <Segmented
                              value={currentMode}
                              onChange={(v) => form.setValue(`clips.${index}.mode`, v as "edited" | "raw")}
                              options={[
                                { value: "edited", label: "Edited" },
                                { value: "raw", label: "Raw" },
                              ]}
                            />
                            {clipCount > 1 && (
                              <button
                                type="button"
                                onClick={() => remove(index)}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove clip"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          <div className="p-4 space-y-3.5">
                            {/* in / out / duration */}
                            <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                              <div>
                                <FieldLabel>In</FieldLabel>
                                <Input
                                  placeholder="00:00:00"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.startTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.startTime`)}
                                />
                              </div>
                              <div>
                                <FieldLabel>Out</FieldLabel>
                                <Input
                                  placeholder="00:00:15"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.endTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.endTime`)}
                                />
                              </div>
                              <div className="font-mono text-[11px] text-primary border border-dashed border-primary/30 rounded-lg px-3 py-2.5 text-center whitespace-nowrap">
                                <span className="block text-[9px] text-muted-foreground/60 uppercase tracking-[0.12em]">Length</span>
                                {fmtDuration(start, end)}
                              </div>
                            </div>
                            {form.formState.errors.clips?.[index]?.endTime && (
                              <p className="text-[10px] text-destructive font-mono -mt-1.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                            )}

                            {/* headline */}
                            {!isRaw && (
                              <div>
                                <Input
                                  placeholder="Overlay headline…"
                                  className={`text-sm bg-background ${form.formState.errors.clips?.[index]?.headline ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.headline`)}
                                />
                                {form.formState.errors.clips?.[index]?.headline && (
                                  <p className="text-[10px] text-destructive font-mono mt-1">{form.formState.errors.clips[index]!.headline!.message}</p>
                                )}
                              </div>
                            )}

                            {/* Pro 2: transformative format picker (edited only). Only Essay is
                                active in Phase 1; Contrast/Narrative are shown as "soon". */}
                            {!isRaw && (
                              <div>
                                <FieldLabel>Format</FieldLabel>
                                <div className="inline-flex bg-background border border-border rounded-lg p-[3px] gap-[3px]">
                                  {[
                                    { value: "essay", label: "Essay", enabled: true },
                                    { value: "narrative", label: "Narrative", enabled: true },
                                    { value: "contrast", label: "Contrast", enabled: true },
                                  ].map((o) => (
                                    <button
                                      key={o.value}
                                      type="button"
                                      disabled={!o.enabled}
                                      onClick={() => o.enabled && form.setValue(`clips.${index}.format`, o.value as "essay" | "contrast" | "narrative")}
                                      title={o.enabled ? undefined : "Coming soon"}
                                      className={`flex items-center gap-1.5 rounded-md px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                                        fmt === o.value
                                          ? "bg-primary text-primary-foreground"
                                          : o.enabled
                                            ? "text-muted-foreground hover:text-foreground"
                                            : "text-muted-foreground/40 cursor-not-allowed"
                                      }`}
                                    >
                                      {o.label}
                                      {!o.enabled && <span className="text-[8px] tracking-normal lowercase opacity-70">soon</span>}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* toggles */}
                            <div className="flex flex-wrap gap-2">
                              <ToggleChip
                                label="Captions"
                                checked={form.watch(`clips.${index}.captionsEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.captionsEnabled`, v)}
                              />
                              <ToggleChip
                                label="Outro card"
                                checked={form.watch(`clips.${index}.outroEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.outroEnabled`, v)}
                              />
                            </div>

                            {/* AI Auto-Zoom panel (edited only) */}
                            {!isRaw && (
                              <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2.5 cursor-pointer">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${punchOn ? "bg-primary border-primary" : "border-muted-foreground/50"}`}
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.punchInEnabled`, !punchOn); }}
                                    >
                                      {punchOn && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3.5} />}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-foreground flex items-center gap-1.5"
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.punchInEnabled`, !punchOn); }}
                                    >
                                      <ZoomIn className="w-3.5 h-3.5 text-primary" /> AI Auto-Zoom
                                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-primary border border-primary/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />AI</span>
                                    </span>
                                  </label>
                                  {punchOn && (
                                    <button
                                      type="button"
                                      onClick={() => copyZoomPrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-primary hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  )}
                                </div>
                                {punchOn && (
                                  <Input
                                    placeholder="Paste Gemini's pairs — e.g. 3 punch, 9 pushin, 16 kenburns   (blank = auto punch every 5s)"
                                    className="text-sm bg-background mt-2.5 font-mono"
                                    {...form.register(`clips.${index}.zoomMoments`)}
                                  />
                                )}
                              </div>
                            )}

                            {/* voiceover PRO panel (edited only) */}
                            {!isRaw && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2.5 cursor-pointer">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
                                        voOn ? "bg-[#9b7bff] border-[#9b7bff]" : "border-muted-foreground/50"
                                      }`}
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      {voOn && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5"
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" /> AI Voiceover Hook
                                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                                    </span>
                                  </label>
                                  {voOn && (
                                    <button
                                      type="button"
                                      onClick={() => copyHookPrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  )}
                                </div>
                                {voOn && (
                                  <Input
                                    placeholder="Spoken intro hook — type it, or paste from your Gemini app…"
                                    className="text-sm bg-background mt-2.5"
                                    {...form.register(`clips.${index}.voiceoverHook`)}
                                  />
                                )}
                              </div>
                            )}

                            {/* Pro 2: Essay script panel (edited + Essay format). The full narration
                                Piper speaks over the clip — what makes it "transformative". */}
                            {!isRaw && isEssay && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5">
                                    <ScrollText className="w-3.5 h-3.5 text-[#9b7bff]" /> AI Essay Script
                                    <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO 2</span>
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => copyEssayPrompt(index)}
                                    className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                  >
                                    <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                  </button>
                                </div>
                                <Textarea
                                  placeholder="Paste your Gemini essay script here — thesis → evidence → synthesis. The voice reads it over the clip."
                                  rows={4}
                                  className="text-sm bg-background mt-2.5 leading-relaxed"
                                  {...form.register(`clips.${index}.essayScript`)}
                                />
                                <p className="text-[9.5px] text-muted-foreground/70 mt-1.5 font-mono leading-relaxed">
                                  Read over the clip with the source audio ducked underneath. Keep it within the clip length — longer scripts get cut off.
                                </p>
                              </div>
                            )}

                            {/* Pro 2: Narrative panel (edited + Narrative format). The In/Out above
                                is Moment 1; add the rest here, then narrate the story across them. */}
                            {!isRaw && fmt === "narrative" && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3 space-y-3">
                                <p className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5">
                                  <ScrollText className="w-3.5 h-3.5 text-[#9b7bff]" /> Story Moments
                                  <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO 2</span>
                                </p>
                                <p className="text-[9.5px] text-muted-foreground/70 font-mono leading-relaxed -mt-1">
                                  Moment 1 = the link + In/Out above. Add the next chapters below; they play back-to-back into one story.
                                </p>
                                <SegmentEditor form={form} index={index} format="narrative" />

                                <div className="border-t border-[#9b7bff]/15 pt-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5">
                                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" /> Narrative Script
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => copyNarrativePrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  </div>
                                  <Textarea
                                    placeholder="Paste your Gemini story script — hook → build-up → the big reaction → payoff. The voice reads it across all the moments."
                                    rows={4}
                                    className="text-sm bg-background mt-2.5 leading-relaxed"
                                    {...form.register(`clips.${index}.essayScript`)}
                                  />
                                </div>
                              </div>
                            )}

                            {/* Pro 2: Contrast panel (edited + Contrast format). Streamer A = the
                                link + In/Out above; add Streamer B below; they play side-by-side. */}
                            {!isRaw && fmt === "contrast" && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3 space-y-3">
                                <p className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5">
                                  <Eye className="w-3.5 h-3.5 text-[#9b7bff]" /> Side-by-Side Compare
                                  <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO 2</span>
                                </p>
                                <p className="text-[9.5px] text-muted-foreground/70 font-mono leading-relaxed -mt-1">
                                  Streamer A (top) = the link + In/Out above. Add Streamer B (bottom) reacting to the SAME moment — they show stacked, A over B.
                                </p>
                                <SegmentEditor form={form} index={index} format="contrast" />

                                <div className="border-t border-[#9b7bff]/15 pt-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5">
                                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" /> Comparison Script
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => copyContrastPrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  </div>
                                  <Textarea
                                    placeholder="Paste your Gemini comparison script — how A's reaction differs from B's, and whose is more telling. Read over the side-by-side clip."
                                    rows={4}
                                    className="text-sm bg-background mt-2.5 leading-relaxed"
                                    {...form.register(`clips.${index}.essayScript`)}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* add clip */}
                  <button
                    type="button"
                    onClick={() => clipCount < MAX_CLIPS && append({ ...defaultClip })}
                    disabled={clipCount >= MAX_CLIPS}
                    className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                      clipCount >= MAX_CLIPS
                        ? "text-muted-foreground/30 border-border cursor-not-allowed"
                        : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {clipCount >= MAX_CLIPS ? `Max ${MAX_CLIPS} clips reached` : `Add clip (${clipCount}/${MAX_CLIPS})`}
                  </button>

                  {/* CTA */}
                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {clipCount} job{clipCount > 1 ? "s" : ""} ready · ~25–30 min on phone
                    </span>
                    <Button type="submit" disabled={isSubmitting} className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7">
                      {isSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><SendHorizonal className="mr-2 h-4 w-4" />ENQUEUE {clipCount} JOB{clipCount > 1 ? "S" : ""}</>
                      )}
                    </Button>
                  </div>
                </form>
              )}

              {sourceTab === "local" && (
                <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-5">
                  <div>
                    <FieldLabel>Video file <span className="text-muted-foreground/50 normal-case">(max 20 GB)</span></FieldLabel>
                    <div
                      className={`relative flex items-center gap-3 rounded-lg border bg-background px-4 py-3 cursor-pointer hover:bg-background/70 transition-colors ${localErrors.file ? "border-destructive" : "border-border"}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileVideo className={`w-5 h-5 shrink-0 ${selectedFile ? "text-primary" : "text-muted-foreground/50"}`} />
                      <div className="flex-1 min-w-0">
                        {selectedFile ? (
                          <>
                            <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                            <p className="text-[10px] font-mono text-muted-foreground">
                              {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Click to browse or drag a video file here</p>
                        )}
                      </div>
                      {selectedFile && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          if (file && file.size > MAX_FILE_BYTES) {
                            toast({ title: "File too large", variant: "destructive" });
                            return;
                          }
                          setSelectedFile(file);
                          setLocalErrors((prev) => ({ ...prev, file: undefined }));
                        }}
                      />
                    </div>
                    {localErrors.file && <p className="text-xs text-destructive font-mono mt-1.5">{localErrors.file}</p>}
                  </div>

                  <div>
                    <FieldLabel>Mode</FieldLabel>
                    <Segmented
                      value={localForm.mode}
                      onChange={(m) => {
                        setLocalForm((p) => ({ ...p, mode: m as "edited" | "raw" }));
                        if (m === "raw") setLocalErrors((p) => ({ ...p, headline: undefined }));
                      }}
                      options={[
                        { value: "edited", label: "Edited" },
                        { value: "raw", label: "Raw" },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>In</FieldLabel>
                      <Input
                        placeholder="00:00:00"
                        className={`font-mono text-sm bg-background ${localErrors.startTime ? "border-destructive" : ""}`}
                        value={localForm.startTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, startTime: e.target.value }))}
                      />
                      {localErrors.startTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.startTime}</p>}
                    </div>
                    <div>
                      <FieldLabel>Out</FieldLabel>
                      <Input
                        placeholder="00:01:00"
                        className={`font-mono text-sm bg-background ${localErrors.endTime ? "border-destructive" : ""}`}
                        value={localForm.endTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, endTime: e.target.value }))}
                      />
                      {localErrors.endTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.endTime}</p>}
                    </div>
                  </div>

                  {localForm.mode === "edited" && (
                    <div>
                      <FieldLabel>Overlay headline</FieldLabel>
                      <Input
                        placeholder="Overlay headline…"
                        className={`text-sm bg-background ${localErrors.headline ? "border-destructive" : ""}`}
                        value={localForm.headline}
                        onChange={(e) => setLocalForm((p) => ({ ...p, headline: e.target.value }))}
                      />
                      {localErrors.headline && <p className="text-xs text-destructive font-mono mt-1">{localErrors.headline}</p>}
                    </div>
                  )}

                  <div>
                    <FieldLabel>Source creator <span className="text-muted-foreground/50 normal-case">(optional)</span></FieldLabel>
                    <Input
                      placeholder="e.g. KSI, MrBeast, IShowSpeed"
                      className="font-mono text-sm bg-background"
                      value={localForm.sourceChannel}
                      onChange={(e) => setLocalForm((p) => ({ ...p, sourceChannel: e.target.value }))}
                    />
                  </div>

                  <ToggleChip
                    label="Enable captions"
                    checked={localForm.captionsEnabled}
                    onChange={(v) => setLocalForm((p) => ({ ...p, captionsEnabled: v }))}
                  />

                  {uploadProgress !== null && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                        <span>Uploading…</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <Button
                      type="button"
                      disabled={isUploading}
                      onClick={handleLocalUpload}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {isUploading ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />UPLOADING…</>
                      ) : (
                        <><Upload className="mr-2 h-4 w-4" />UPLOAD &amp; PROCESS</>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
