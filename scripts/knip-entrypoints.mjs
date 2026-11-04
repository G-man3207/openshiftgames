// Knip entry mirror for the browser shell.
//
// index.html and draw.html run their UI from inline `<script type="module">` blocks. Static
// analysis of the repo (Knip, verify) cannot see imports inside HTML, so this file re-declares
// every `./js/...` module the inline scripts import — statically or dynamically — to keep the
// whole browser module graph reachable for dead-file detection. It is never served, bundled or
// imported at runtime; its only consumer is `npx knip`.
//
// Keep in sync with the inline modules of index.html and draw.html. `node scripts/verify.mjs`
// fails when an inline import is missing here, so this mirror cannot silently rot.
//
// Static imports — index.html shell:
import { GameEngine, GAME_MODES, GAME_STATES } from '../js/engine/GameEngine.js';
import {
  createResource,
  PALETTE_SECTIONS,
  PLACEABLE_KINDS,
  paletteMeta,
  KIND_DEFS,
  isClusterScopedKind,
  toManifestObject,
  RESOURCE_KINDS,
  apiVersionForKind,
  defaultSpecForKind,
  normalizeKind,
} from '../js/data/kindRegistry.js';
import { ClusterRenderer } from '../js/rendering/ClusterRenderer.js';
import { IncidentEngine } from '../js/engine/IncidentEngine.js';
import { ScoringEngine } from '../js/engine/ScoringEngine.js';
import { HUD } from '../js/ui/HUD.js';
import { CommandBar } from '../js/ui/CommandBar.js';
import { InspectorPanel } from '../js/ui/InspectorPanel.js';
import { ContextMenu } from '../js/ui/ContextMenu.js';
import { MetricsDashboard } from '../js/ui/MetricsDashboard.js';
import { IncidentPanel } from '../js/ui/IncidentPanel.js';
import { Minimap } from '../js/ui/Minimap.js';
import { StartMenu } from '../js/ui/StartMenu.js';
import { CampaignMode } from '../js/modes/CampaignMode.js';
import { ChaosMode } from '../js/modes/ChaosMode.js';
import { SandboxMode } from '../js/modes/SandboxMode.js';
import { ChallengeMode } from '../js/modes/ChallengeMode.js';
import { CAMPAIGN_LEVELS, CHAPTERS } from '../js/data/CampaignLevels.js';
import { ACHIEVEMENTS } from '../js/data/Achievements.js';
import { CHALLENGES } from '../js/modes/ChallengeMode.js';
// Static imports — draw.html whiteboard:
import { computeConnections } from '../js/rendering/RelationGraph.js';
// Dynamic import() targets in index.html (Files panel and EX280 Prep are loaded on demand):
import '../js/ui/ManifestPanel.js';
import '../js/modes/ExamPrepMode.js';
