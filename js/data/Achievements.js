/**
 * Achievements — OpenShift-themed unlockable achievements for shifting.pro.
 *
 * Achievement conditions receive the ScoringEngine `stats` contract from
 * CONVERSION-SPEC §12. The ScoringEngine is owned by modes-dev and is being
 * rewritten in parallel, so every condition is defensive:
 *  - numbers are coerced with `n()` (missing/undefined -> 0),
 *  - renamed counters have migration fallbacks
 *    (`projectsCreated` <- `namespacesCreated`, `rolebindingsCreated` <-
 *    `roleBindingsCreated`),
 *  - optional counters that the contract may add later
 *    (`resourceQuotasCreated`, `canIAllowed`, `authChecksAllowed`) degrade to
 *    "not unlocked yet" instead of throwing.
 *
 * Required stat fields (CONVERSION-SPEC §12): totalPodsDeployed,
 * deploymentsCreated, servicesCreated, projectsCreated, routesCreated,
 * buildsCompleted, imageStreamsCreated, templatesProcessed, helmReleases,
 * manifestsApplied, kustomizeOverlaysApplied, usersCreated, groupsCreated,
 * rolebindingsCreated, sccGrants, operatorsInstalled, incidentsResolved,
 * maxConcurrentPods, levelsCompleted, chaptersCompleted, threeStarLevels,
 * totalStars, challengesCompleted, threeStarChallenges, longestChaosSurvival,
 * commandsExecuted, yamlViewed, architectureScore, examPrepMastered.
 */

import { CAMPAIGN_ORDER, EX280_ORDER, PRELUDE_ORDER } from './CampaignLevels.js';

const n = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Campaign totals come from the level data so the copy and the thresholds can
// never drift from the real campaign (1.16.0 added levels and a Linux prelude).
const EX280_LEVEL_COUNT = EX280_ORDER.length;
const CAMPAIGN_STAR_COUNT = CAMPAIGN_ORDER.length * 3;

/** First defined numeric stat among aliases (migration-friendly). */
const stat = (stats, ...keys) => {
  if (!stats || typeof stats !== 'object') return 0;
  for (const key of keys) {
    if (stats[key] !== undefined && stats[key] !== null) return n(stats[key]);
  }
  return 0;
};

const ACHIEVEMENTS = [
  // ─────────────────────────────── BEGINNER ────────────────────────────────
  {
    id: 'first-project',
    name: 'Project Pioneer',
    description: 'Create your first OpenShift Project.',
    icon: 'folder',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'projectsCreated', 'namespacesCreated') >= 1,
    xpReward: 25,
  },
  {
    id: 'first-pod',
    name: 'Pod Rookie',
    description: 'Deploy your first Pod.',
    icon: 'seedling',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'totalPodsDeployed') >= 1,
    xpReward: 25,
  },
  {
    id: 'first-deployment',
    name: 'Deployer',
    description: 'Create your first Deployment.',
    icon: 'rocket',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'deploymentsCreated') >= 1,
    xpReward: 25,
  },
  {
    id: 'first-service',
    name: 'Service Provider',
    description: 'Create your first Service.',
    icon: 'link',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'servicesCreated') >= 1,
    xpReward: 25,
  },
  {
    id: 'first-route',
    name: 'Exposed',
    description: 'Create your first Route and expose an application.',
    icon: 'globe',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'routesCreated') >= 1,
    xpReward: 50,
  },
  {
    id: 'first-incident',
    name: 'First Responder',
    description: 'Resolve your first incident.',
    icon: 'shield',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'incidentsResolved') >= 1,
    xpReward: 50,
  },
  {
    id: 'first-command',
    name: 'oc Operator',
    description: 'Run your first `oc` command in the command bar.',
    icon: 'terminal',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'commandsExecuted') >= 1,
    xpReward: 10,
  },
  {
    id: 'first-yaml',
    name: 'YAML Initiate',
    description: 'Inspect a resource manifest in the YAML view.',
    icon: 'document',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'yamlViewed') >= 1,
    xpReward: 25,
  },
  {
    id: 'level-complete',
    name: 'Graduate',
    description: 'Complete your first campaign level.',
    icon: 'graduation',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'levelsCompleted') >= 1,
    xpReward: 50,
  },
  {
    id: 'first-build',
    name: 'Build Engineer',
    description: 'Complete your first BuildConfig build.',
    icon: 'gear',
    category: 'Beginner',
    condition: (stats) => stat(stats, 'buildsCompleted') >= 1,
    xpReward: 75,
  },

  // ────────────────────────────── INTERMEDIATE ─────────────────────────────
  {
    id: 'five-pods',
    name: 'Pod Herder',
    description: 'Run 5 Pods at the same time.',
    icon: 'sprout',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'maxConcurrentPods') >= 5,
    xpReward: 50,
  },
  {
    id: 'three-stars',
    name: 'Star Collector',
    description: 'Earn 3 stars on any campaign level.',
    icon: 'star',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'threeStarLevels') >= 1,
    xpReward: 75,
  },
  {
    id: 'chapter-one',
    name: 'Chapter Champion',
    description: 'Complete your first campaign chapter.',
    icon: 'book',
    category: 'Intermediate',
    condition: (stats) =>
      stat(stats, 'chaptersCompleted') >= 1 || stat(stats, 'preludeCompleted') >= 1,
    xpReward: 150,
  },
  {
    id: 'manifest-master',
    name: 'Manifest Applier',
    description: 'Apply 5 YAML manifests with `oc apply -f`.',
    icon: 'document',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'manifestsApplied') >= 5,
    xpReward: 100,
  },
  {
    id: 'kustomize-apprentice',
    name: 'Kustomize Apprentice',
    description: 'Apply your first Kustomize overlay.',
    icon: 'layers',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'kustomizeOverlaysApplied') >= 1,
    xpReward: 100,
  },
  {
    id: 'templated',
    name: 'Template Wizard',
    description: 'Process an OpenShift Template with `oc process`.',
    icon: 'wand',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'templatesProcessed') >= 1,
    xpReward: 100,
  },
  {
    id: 'helm-release',
    name: 'Chart Master',
    description: 'Install your first Helm release.',
    icon: 'ship',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'helmReleases') >= 1,
    xpReward: 100,
  },
  {
    id: 'build-pipeline',
    name: 'Build Pipeline',
    description: 'Complete 3 builds in a single session.',
    icon: 'factory',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'buildsCompleted') >= 3,
    xpReward: 125,
  },
  {
    id: 'image-streamer',
    name: 'Image Streamer',
    description: 'Create your first ImageStream.',
    icon: 'disks',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'imageStreamsCreated') >= 1,
    xpReward: 100,
  },
  {
    id: 'first-user',
    name: 'Identity Provider',
    description: 'Create your first OpenShift User.',
    icon: 'person',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'usersCreated') >= 1,
    xpReward: 75,
  },

  // ──────────────────────────────── ADVANCED ───────────────────────────────
  {
    id: 'operator-installed',
    name: 'Operator Installer',
    description: 'Install an Operator from a Subscription.',
    icon: 'puzzle',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'operatorsInstalled') >= 1,
    xpReward: 200,
  },
  {
    id: 'scc-granted',
    name: 'SCC Gatekeeper',
    description: 'Grant a SecurityContextConstraint to a user or ServiceAccount.',
    icon: 'lock',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'sccGrants') >= 1,
    xpReward: 200,
  },
  {
    id: 'rbac-architect',
    name: 'RBAC Architect',
    description: 'Create 3 RoleBindings that grant access in your projects.',
    icon: 'key',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'rolebindingsCreated', 'roleBindingsCreated') >= 3,
    xpReward: 200,
  },
  {
    id: 'group-lead',
    name: 'Group Lead',
    description: 'Create 2 OpenShift Groups.',
    icon: 'people',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'groupsCreated') >= 2,
    xpReward: 150,
  },
  {
    id: 'quota-guardian',
    name: 'Quota Guardian',
    description: 'Create a ResourceQuota or LimitRange guardrail.',
    icon: 'chart',
    category: 'Advanced',
    // Optional ScoringEngine counters; safe if absent.
    condition: (stats) =>
      stat(
        stats,
        'resourceQuotasCreated',
        'resourceQuotaCreated',
        'quotasCreated',
        'limitRangesCreated'
      ) >= 1,
    xpReward: 150,
  },
  {
    id: 'can-i-allowed',
    name: 'Permission Checker',
    description: 'Prove access with `oc auth can-i`.',
    icon: 'check',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'canIAllowed', 'authChecksAllowed', 'canIChecks') >= 1,
    xpReward: 100,
  },
  {
    id: 'kustomize-overlay-pro',
    name: 'Overlay Engineer',
    description: 'Apply 5 Kustomize overlays.',
    icon: 'layers',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'kustomizeOverlaysApplied') >= 5,
    xpReward: 200,
  },
  {
    id: 'manifest-engineer',
    name: 'Manifest Engineer',
    description: 'Apply 20 YAML manifests.',
    icon: 'code',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'manifestsApplied') >= 20,
    xpReward: 250,
  },
  {
    id: 'chapter-three',
    name: 'Halfway Admin',
    description: 'Complete 3 campaign chapters.',
    icon: 'route',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'chaptersCompleted') >= 3,
    xpReward: 300,
  },
  {
    id: 'exam-prep-first',
    name: 'EX280 Tracker',
    description: 'Master your first EX280 Prep objective.',
    icon: 'target',
    category: 'Advanced',
    condition: (stats) => stat(stats, 'examPrepMastered') >= 1,
    xpReward: 150,
  },

  // ───────────────────────────────── EXPERT ────────────────────────────────
  {
    id: 'final-level',
    name: 'Campaign Graduate',
    description: `Complete all ${EX280_LEVEL_COUNT} EX280 campaign levels, including the Production Platform capstone.`,
    icon: 'trophy',
    category: 'Expert',
    // EX280 track only: the optional Linux prelude must not count towards it.
    condition: (stats) => stat(stats, 'ex280LevelsCompleted') >= EX280_LEVEL_COUNT,
    xpReward: 1000,
  },
  {
    id: 'star-master',
    name: 'Star Master',
    description: `Earn all ${CAMPAIGN_STAR_COUNT} campaign stars (${CAMPAIGN_ORDER.length} levels × 3, the Linux prelude included).`,
    icon: 'star',
    category: 'Expert',
    condition: (stats) => stat(stats, 'totalStars') >= CAMPAIGN_STAR_COUNT,
    xpReward: 1000,
  },
  {
    id: 'linux-foundations',
    name: 'Linux Foundations',
    description: `Complete all ${PRELUDE_ORDER.length || 7} Linux & RHEL Foundations levels.`,
    icon: 'terminal',
    category: 'Intermediate',
    condition: (stats) => stat(stats, 'preludeCompleted') >= 1,
    xpReward: 200,
  },
  {
    id: 'chapter-master',
    name: 'Platform Architect',
    description: 'Complete all 5 EX280 campaign chapters.',
    icon: 'building',
    category: 'Expert',
    condition: (stats) => stat(stats, 'chaptersCompleted') >= 5,
    xpReward: 750,
  },
  {
    id: 'platform-architect',
    name: 'Architecture Advisor',
    description: 'Reach an Architecture Advisor score of 80 or higher.',
    icon: 'compass',
    category: 'Expert',
    condition: (stats) => stat(stats, 'bestArchitectureScore', 'architectureScore') >= 80,
    xpReward: 500,
  },
  {
    id: 'exam-prep-90',
    name: 'Exam Ready',
    description: 'Master 90% of the EX280V422 objectives (50 of 55 bullets).',
    icon: 'certificate',
    category: 'Expert',
    // Count-based (50/55) with a percentage-based engines still being written.
    condition: (stats) => {
      const mastered = stat(stats, 'examPrepMastered');
      return mastered >= 50;
    },
    xpReward: 1000,
  },
  {
    id: 'chaos-survivor',
    name: 'Chaos Survivor',
    description: 'Survive 60 seconds of Chaos Mode.',
    icon: 'fire',
    category: 'Expert',
    condition: (stats) => stat(stats, 'longestChaosSurvival') >= 60,
    xpReward: 250,
  },
  {
    id: 'three-star-champ',
    name: 'Perfectionist',
    description: 'Earn 3 stars on 10 campaign levels.',
    icon: 'medal',
    category: 'Expert',
    condition: (stats) => stat(stats, 'threeStarLevels') >= 10,
    xpReward: 750,
  },
  {
    id: 'challenge-veteran',
    name: 'Lab Veteran',
    description: 'Complete all 13 challenge labs.',
    icon: 'flask',
    category: 'Expert',
    condition: (stats) => stat(stats, 'challengesCompleted') >= 13,
    xpReward: 750,
  },
  {
    id: 'incident-veteran',
    name: 'Incident Commander',
    description: 'Resolve 10 incidents.',
    icon: 'siren',
    category: 'Expert',
    condition: (stats) => stat(stats, 'incidentsResolved') >= 10,
    xpReward: 300,
  },
  {
    id: 'oc-power-user',
    name: 'oc Power User',
    description: 'Execute 100 `oc` commands.',
    icon: 'terminal',
    category: 'Expert',
    condition: (stats) => stat(stats, 'commandsExecuted') >= 100,
    xpReward: 300,
  },

  // ──────────────────────────────── SECRET ─────────────────────────────────
  {
    id: 'coffee-break',
    name: 'Coffee Break',
    description: 'Order coffee from the cluster.',
    icon: 'coffee',
    category: 'Secret',
    condition: (stats) => stats?.easterEggs?.['coffee-break'] === true,
    xpReward: 5,
  },
  {
    id: 'party-mode',
    name: 'Party Mode',
    description: 'Find the hidden disco.',
    icon: 'disco',
    category: 'Secret',
    condition: (stats) => stats?.easterEggs?.['party-mode'] === true,
    xpReward: 50,
  },
  {
    id: 'konami-code',
    name: 'Up Up Down Down',
    description: 'Create a Pod named konami.',
    icon: 'gamepad',
    category: 'Secret',
    condition: (stats) => stats?.easterEggs?.['konami-code'] === true,
    xpReward: 100,
  },
  {
    id: 'oc-alias',
    name: 'Say It With oc',
    description: 'Run 25 commands with the oc CLI - the command the exam asks for.',
    icon: 'terminal',
    category: 'Secret',
    condition: (stats) => stat(stats, 'commandsExecuted') >= 25,
    xpReward: 25,
  },
];

const ACHIEVEMENT_CATEGORIES = {
  Beginner: { color: '#22c55e', minLevel: 0 },
  Intermediate: { color: '#3b82f6', minLevel: 5 },
  Advanced: { color: '#a855f7', minLevel: 15 },
  Expert: { color: '#EE0000', minLevel: 20 },
  Secret: { color: '#f59e0b', minLevel: 0 },
};

export { ACHIEVEMENTS, ACHIEVEMENT_CATEGORIES };
