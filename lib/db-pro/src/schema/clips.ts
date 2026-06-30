import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clipsTable = pgTable("clips_pro2", {
  id: serial("id").primaryKey(),
  youtubeUrl: text("youtube_url"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  headline: text("headline").notNull().default(""),
  mode: text("mode").notNull().default("edited"),
  frameStyle: text("frame_style").notNull().default("immersive"),
  sourceType: text("source_type").notNull().default("youtube"),
  localFilePath: text("local_file_path"),
  localFileName: text("local_file_name"),
  status: text("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),
  errorMessage: text("error_message"),
  outputFilename: text("output_filename"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  sourceChannel: text("source_channel").notNull().default(""),
  captionsEnabled: boolean("captions_enabled").notNull().default(true),
  // Pro 2: outcome of the whisper caption stage so an OOM/crash that produces a captionless
  // clip is VISIBLE instead of silently shipped as "done". null = not run; "ok" = burned;
  // "skipped" = clean run, no speech detected; "failed" = whisper produced nothing (likely the
  // phone OOM-killed it). Non-fatal — the video still renders. See memory: render-oom-crash.
  captionStatus: text("caption_status"),
  transcript: text("transcript"),
  // Pro-only: AI intro-hook voiceover. The hook line is user-supplied (typed or
  // pasted from their Gemini app); Piper TTS speaks it over the first few seconds.
  voiceoverEnabled: boolean("voiceover_enabled").notNull().default(false),
  voiceoverHook: text("voiceover_hook"),
  // Pro-only: AI Auto-Zoom. punchInEnabled gates the effect; zoomMoments is the
  // Gemini-chosen "second type" list. Persisted so Retry re-renders WITH the zoom
  // (previously these rode only the create request and were lost on retry).
  punchInEnabled: boolean("punch_in_enabled").notNull().default(false),
  zoomMoments: text("zoom_moments").notNull().default(""),
  // Whether the closing outro/CTA is appended (a real toggle, defaults on). Persisted so
  // Retry restores it too, instead of forcing it back on.
  outroEnabled: boolean("outro_enabled").notNull().default(true),
  // Pro 2: the "transformative" editing format. "essay" = use the clip as evidence for a
  // point, with a full AI-narrated script (thesis -> evidence -> synthesis). Future formats:
  // "contrast" (compare two streamers) and "narrative" (multi-segment story). Persisted so
  // Retry re-renders in the same format.
  format: text("format").notNull().default("essay"),
  // Pro 2: the full essay narration script. User-supplied — they paste it from their own
  // Gemini app (built by the "Copy Gemini prompt" button). Piper TTS speaks the whole script
  // over the clip with the source audio ducked underneath. Distinct from the short
  // voiceoverHook (intro-only) so both can coexist. Reused as the narration for every format.
  essayScript: text("essay_script"),
  // Pro 2 multi-clip formats (narrative/contrast): JSON-encoded array of source segments
  // [{youtubeUrl,startTime,endTime,sourceChannel?,label?}]. The processor downloads each and
  // combines them into ONE intermediate video (narrative=concat in order, contrast=vstack of 2)
  // before the normal composite pipeline runs. Null for single-clip formats (essay), which use
  // the top-level youtubeUrl/startTime/endTime instead.
  segments: text("segments"),
});

export const insertClipSchema = createInsertSchema(clipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  errorMessage: true,
  outputFilename: true,
  transcript: true,
});

export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clipsTable.$inferSelect;
