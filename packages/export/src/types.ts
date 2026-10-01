import type { ExportManifest, ExportOwnedFile, ExportPreset } from "@brainforge/contracts";

/** Declared Godot target. `resRootPrefix` is the `res://` URL of the export destination (no `/current`, no trailing slash). */
export interface GodotTarget {
  projectRootAbs: string;
  resRootPrefix: string;
}

export type ExportPackaging = "frames" | "atlas" | "both";

export interface ExportFrame {
  index: number;
  durationMs: number;
  sourceFrame: number;
  /** Absolute path of the frame PNG; required when packaging is `frames` or `both`. */
  sourcePath?: string;
  /** Packed rectangle; required when packaging is `atlas` or `both`. */
  atlas?: { page: number; x: number; y: number; width: number; height: number };
}

export type ExportMedia =
  | { kind: "still"; sourcePath: string }
  | {
      kind: "animation";
      frames: ExportFrame[];
      /** Atlas pages in page order; required when packaging is `atlas` or `both`. */
      atlasPages?: { sourcePath: string; width: number; height: number }[];
      loop: boolean;
      sourceFps: number;
      playbackFps: number;
      packaging: ExportPackaging;
    };

export interface ExportTile {
  width: number;
  height: number;
  connections?: { north?: string; east?: string; south?: string; west?: string };
  seamlessAxes?: ("x" | "y")[];
}

export interface ExportDeliverable {
  deliverableId: string;
  kind: string;
  candidateId: string;
  outputHash: string;
  media: ExportMedia;
  canvas: { width: number; height: number };
  /** Pixel pivot, origin top-left, x right, y down. */
  pivot: { x: number; y: number };
  displayScale?: number;
  relativeScale?: number;
  nineSlice?: { left: number; top: number; right: number; bottom: number };
  /** Named UI/variant state (`ui.state`); the sprite sheet entry carries it. Defaults to the deliverable id. */
  state?: string;
  tile?: ExportTile;
  /** Applicable family metadata (layer, parallax, attachment pivots, ...). Copied verbatim into asset.json. */
  metadata: Record<string, unknown>;
}

export interface ExportAsset {
  assetId: string;
  family: string;
  versionId: string;
  requirementsHash: string;
  dependencies: { assetId: string; versionId: string }[];
  metadata: Record<string, unknown>;
  deliverables: ExportDeliverable[];
  /** Still packaging: `atlas` packs this asset's non-tile stills into sprites/atlas-<n>.png, `both` also keeps their PNGs. Default individual. */
  sprites?: "individual" | "atlas" | "both";
}

export interface ExportInput {
  projectId: string;
  exportId: string;
  preset: ExportPreset;
  createdAt: string;
  /** Required for `godot4`. */
  godot?: GodotTarget;
  assets: ExportAsset[];
}

export interface ExportOutcome {
  manifest: ExportManifest;
  /** Serialized `manifest.json` exactly as written. */
  manifestText: string;
  /** sha256 of `manifestText`; the manifest does not list itself in `ownedFiles`. */
  manifestSha256: string;
  /** Every file written except `manifest.json`. */
  ownedFiles: ExportOwnedFile[];
  warnings: string[];
}

export type ExportErrorCode = "EXPORT_CONFLICT" | "EXPORT_BLOCKED" | "INVALID_INPUT" | "IO_ERROR";

export interface ExportFaults {
  failDuringStaging?: boolean;
  failBeforeSwitch?: boolean;
  failAfterSwitchBeforeRetire?: boolean;
}

/** Serializable record of a prepared publication; the Core stores it so a crashed export can be recovered. */
export interface ExportIntent {
  exportId: string;
  projectId: string;
  preset: ExportPreset;
  /** Destination-relative backing release, `.releases/<exportId>`. */
  releaseDir: string;
  manifestSha256: string;
  /** Owned files in the prepared release (manifest excluded). */
  files: ExportOwnedFile[];
  /** Unowned files copied into the prepared release; removed with it if never switched in. */
  carried: ExportOwnedFile[];
  /** What `current` resolved to when this export was prepared. */
  previous?: {
    exportId: string;
    manifestSha256: string;
    files: ExportOwnedFile[];
    unowned: ExportOwnedFile[];
  };
}

/** What the Core's database believes `current` is; anything else at `current` is a conflict. */
export interface ExpectedCurrent {
  exportId: string;
  manifestSha256: string;
}

export interface PrepareResult {
  intent: ExportIntent;
  outcome: ExportOutcome;
  warnings: string[];
}

export interface CommitResult {
  status: "committed" | "already-committed";
  manifestSha256: string;
  /** Destination-relative public root (`current`). */
  publicRoot: string;
  /** Retirement problems after the switch; the export itself is committed. */
  warnings: string[];
}

export interface RecoverResult {
  status: "committed" | "aborted";
  warnings: string[];
}
