// SPDX-License-Identifier: Apache-2.0
import type { GateResult } from "./gate.js";

/**
 * Core data model for the org graph and analysis results.
 *
 * Salesforce API names are case-insensitive, so every map in OrgModel is keyed by
 * the lower-cased API name (see `key()` in util.ts). Definitions keep the original
 * spelling for display.
 */

export type ComponentType =
  | "CustomObject"
  | "CustomField"
  | "ValidationRule"
  | "ObjectChild"
  | "Flow"
  | "ApexTrigger"
  | "ApexClass"
  | "PermissionSet"
  | "Profile"
  | "AgentMetadata"
  | "WorkflowRule"
  /** Any other Salesforce metadata type: recognized by name (see `metadataType`), not analyzed in depth. */
  | "Metadata"
  | "Other";

/** Which kind of Agentforce metadata an `AgentMetadata` component is. */
export type AgentFileKind =
  | "bot"
  | "botVersion"
  | "planner"
  | "topic"
  | "action"
  | "script"
  | "test"
  | "promptTemplate";

export interface ComponentRef {
  type: ComponentType;
  /** Set for AgentMetadata components. */
  agentKind?: AgentFileKind;
  /** Set for Metadata components: the Salesforce metadata type, e.g. `Layout` or `LightningComponentBundle`. */
  metadataType?: string;
  /** Display name, e.g. `Opportunity.Contract_Signed_Date__c` or `AccountTrigger`. */
  name: string;
  /** Owning object for object-scoped components. */
  object?: string;
  /** Path relative to the project directory, posix separators. */
  file: string;
}

export type DmlOp = "insert" | "update" | "upsert" | "delete" | "undelete";
export type SaveEvent = "insert" | "update" | "delete" | "undelete";
export type Timing = "before" | "after";
export type Confidence = "high" | "medium" | "low";

/** A write performed by an automation (DML in Apex, Create/Update/Delete Records in a flow). */
export interface Write {
  object: string;
  op: DmlOp;
  fields?: string[];
  /** The automation writes back to the record that triggered it. */
  selfUpdate?: boolean;
  /** Field on the written object that is set to (or filtered by) the triggering record's Id. */
  linkField?: string;
  /** Flow element name or Apex line reference. */
  via?: string;
  confidence: Confidence;
}

/** A literal or reference value in flow metadata. */
export interface FlowValue {
  kind: "string" | "number" | "boolean" | "date" | "reference";
  value: string;
}

export interface FlowFilter {
  field: string;
  /** EqualTo, NotEqualTo, IsChanged, IsNull, GreaterThan, … */
  operator: string;
  value?: FlowValue;
}

export interface FieldDef {
  object: string;
  name: string;
  fullName: string;
  type?: string;
  formula?: string;
  /** Field API names referenced by a formula. */
  formulaRefs: string[];
  referenceTo: string[];
  /** `<required>true</required>` (master-detail fields are always required). */
  required?: boolean;
  defaultValue?: string;
  /** Picklist fields: the values defined on the field itself, or the global value set it uses. */
  picklist?: { values: { name: string; active: boolean }[]; valueSetName?: string };
  /** Roll-up summary: this field (on the parent) is recalculated when `childObject` records change. */
  summary?: {
    childObject: string;
    relationshipField: string;
    operation?: string;
    summarizedField?: string;
    filterFields: string[];
  };
  file: string;
}

export interface ObjectDef {
  name: string;
  file?: string;
  fields: Map<string, FieldDef>;
}

export interface ValidationRuleDef {
  object: string;
  name: string;
  fullName: string;
  active: boolean;
  formula: string;
  errorMessage?: string;
  /** Identifiers referenced by the formula (fields or relationship paths). */
  fieldRefs: string[];
  file: string;
}

export interface FlowTrigger {
  object: string;
  timing: Timing;
  events: SaveEvent[];
  /** Fields used in entry criteria. */
  entryFields: string[];
  /** Entry conditions; `filterLogic` is "and", "or", a custom expression or undefined. */
  filters: FlowFilter[];
  filterLogic?: string;
  /** Entry criteria written as a formula instead of filters. */
  filterFormula?: string;
  /** "Only when a record is updated to meet the condition requirements". */
  requiresChange?: boolean;
  hasScheduledPaths: boolean;
}

export interface FlowDef {
  name: string;
  label?: string;
  status: string;
  active: boolean;
  processType?: string;
  /** "DefaultMode", "SystemModeWithSharing" or "SystemModeWithoutSharing". */
  runInMode?: string;
  trigger?: FlowTrigger;
  /** Set for flows started by a platform event: the event's API name. */
  platformEvent?: string;
  writes: Write[];
  reads: string[];
  apexActions: string[];
  subflows: string[];
  /** `Object.Field` references found anywhere in the flow. */
  fieldRefs: string[];
  file: string;
}

export interface LoopIssue {
  kind: "soql-in-loop" | "dml-in-loop";
  line: number;
  snippet: string;
  /** Set when the DML/SOQL happens inside a method called from the loop, e.g. "AccountService.save". */
  via?: string;
}

/** A method call found in Apex source. */
export interface ApexCall {
  /** Target class; undefined for calls to the same class. */
  cls?: string;
  method: string;
  line: number;
  inLoop: boolean;
  /** Name of the calling method ("<trigger>" for trigger bodies). */
  from: string;
  snippet: string;
}

/** Per-method summary used for cross-method and cross-class analysis. */
export interface ApexMethod {
  name: string;
  line: number;
  invocable: boolean;
  isStatic?: boolean;
  /** Parameter types as written, e.g. ["List<Id>"]. */
  params?: string[];
  /** The method body itself contains DML / SOQL (not counting callees). */
  dml: boolean;
  soql: boolean;
}

export interface ApexAnalysis {
  writes: Write[];
  reads: string[];
  classRefs: string[];
  loopIssues: LoopIssue[];
  unresolvedDml: number;
  /** Source with comments and string contents blanked out (same length/lines as original). */
  stripped: string;
  /** "ast" when parsed with the Apex grammar; "heuristic" for the regex fallback. */
  parser?: "ast" | "heuristic";
  /** Syntax errors that forced the heuristic fallback. */
  parseErrors?: { line: number; message: string }[];
  /** AST only: method calls, method summaries and resolved field references. */
  calls?: ApexCall[];
  methods?: ApexMethod[];
  /** `Object.Field` references; `*.Field` when the object could not be resolved. */
  fieldRefs?: string[];
  /** `Object.Field` values assigned in code. */
  fieldWrites?: string[];
}

export interface ApexTriggerDef extends ApexAnalysis {
  name: string;
  object: string;
  events: { timing: Timing; event: SaveEvent }[];
  file: string;
}

export interface ApexClassDef extends ApexAnalysis {
  name: string;
  invocable: boolean;
  isTest: boolean;
  file: string;
}

export interface ObjectGrant {
  object: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export interface FieldGrant {
  field: string;
  readable: boolean;
  editable: boolean;
}

export interface PermissionContainerDef {
  name: string;
  kind: "PermissionSet" | "Profile";
  objects: ObjectGrant[];
  fields: FieldGrant[];
  /** Enabled system permissions, e.g. ModifyAllData. */
  userPermissions: string[];
  /** Apex classes, Visualforce pages and custom permissions it enables. */
  classes?: string[];
  pages?: string[];
  customPermissions?: string[];
  /** Profiles only: the user license, e.g. "Guest User License". */
  userLicense?: string;
  file: string;
}

/** An agent action (GenAiFunction, or an action declared in Agent Script). */
export interface AgentAction {
  /** API name (developer name, or the action's name in Agent Script). */
  name: string;
  label?: string;
  description?: string;
  /** How the action runs: "apex", "flow", "prompt", "standardInvocableAction", … */
  targetType: string;
  /** Apex class, flow or prompt template it calls; undefined for standard actions without one. */
  target?: string;
  /** The agent asks the user to confirm before running it. */
  confirmationRequired?: boolean;
  /** Other names metadata uses to refer to it (developer name, full name, local name). */
  aliases?: string[];
  file: string;
}

/** A topic (GenAiPlugin, or a topic/subagent in Agent Script) and the actions it can use. */
export interface AgentTopic {
  name: string;
  label?: string;
  actions: AgentAction[];
  file: string;
}

export interface AgentDef {
  name: string;
  label?: string;
  /** "Bot": Agent Builder metadata (bots, planners, topics, actions). "AgentScript": an `.agent` file. */
  source: "Bot" | "AgentScript";
  agentType?: string;
  /** Employee agents run as the signed-in user, even when the metadata names a default user. */
  employee?: boolean;
  /**
   * Username of the agent's dedicated runtime user (service agents). Used only to query the org with
   * `--org`; it must never appear in a report.
   */
  runtimeUser?: string;
  topics: AgentTopic[];
  /** Actions the agent can use outside any topic. */
  actions: AgentAction[];
  /** Planner bundles the agent uses. */
  planners: string[];
  /** Main definition file. */
  file: string;
  /** Every file that makes up the agent (bot, versions, planner, topics, actions, script). */
  files: string[];
}

/** A Testing Center test definition (AiEvaluationDefinition or AiTestingDefinition). */
export interface AgentTestDef {
  name: string;
  format: "AiEvaluationDefinition" | "AiTestingDefinition";
  /** The agent it tests (subjectName). */
  subject: string;
  testCases: number;
  /** Topics and actions the test cases expect the agent to choose. */
  topics: string[];
  actions: string[];
  file: string;
}

/** A record type: whether it is active and which picklist values it offers per field. */
export interface RecordTypeDef {
  object: string;
  name: string;
  active: boolean;
  /** Picklist field API name to the values this record type offers. */
  picklists: Record<string, string[]>;
  file: string;
}

/** A page layout: the fields it shows. */
export interface LayoutDef {
  name: string;
  object: string;
  fields: string[];
  file: string;
}

/** A Lightning page: the components placed on it and, for record pages, the fields it names. */
export interface FlexiPageDef {
  name: string;
  /** The object of a record page. */
  object?: string;
  /** `componentName` values: `c:myCmp`, `force:detailPanel`, a bare name for the page's own namespace. */
  components: string[];
  /** `Object.Field` used in filters or field items. */
  fields: string[];
  file: string;
}

/** A Lightning Web Component or Aura bundle: what it calls, imports and embeds. */
export interface LightningDef {
  kind: "lwc" | "aura";
  /** Bundle (folder) name. */
  name: string;
  /** The bundle's main file, for opening it. */
  file: string;
  /** Source files read (not tests). */
  files: string[];
  /** Apex classes it calls; `method` is set when a specific method is imported or invoked. */
  apex: { cls: string; method?: string }[];
  /** `Object.Field` it imports (`@salesforce/schema/...`) or names in a string. */
  fields: string[];
  /** Objects imported on their own (`@salesforce/schema/Account`). */
  objects: string[];
  /** Custom labels it uses. */
  labels: string[];
  /** Components it embeds. */
  children: string[];
}

export interface OrgModel {
  projectDir: string;
  sourceRoots: string[];
  objects: Map<string, ObjectDef>;
  validationRules: ValidationRuleDef[];
  flows: Map<string, FlowDef>;
  triggers: Map<string, ApexTriggerDef>;
  classes: Map<string, ApexClassDef>;
  permissionContainers: Map<string, PermissionContainerDef>;
  /** Agentforce agents, keyed by lower-cased name. */
  agents: Map<string, AgentDef>;
  /** Testing Center test definitions. */
  agentTests: AgentTestDef[];
  /** Lightning Web Component and Aura bundles, keyed by `lwc:name` / `aura:name`, lower-cased. */
  lightning: Map<string, LightningDef>;
  /** Page layouts and Lightning pages, keyed by lower-cased name. */
  layouts: Map<string, LayoutDef>;
  /** Record types, keyed by lower-cased `Object.Name`. */
  recordTypes: Map<string, RecordTypeDef>;
  flexipages: Map<string, FlexiPageDef>;
  /** Every metadata file found, keyed by relative path. */
  components: Map<string, ComponentRef>;
  warnings: string[];
  /** Present when the change was read from a git range. */
  provenance?: Provenance;
  /** Present when analyzed with `--org`: read-only context from a Salesforce org. */
  org?: OrgContext;
}

export interface OrgAutomation {
  kind: "Flow" | "ApexTrigger" | "ValidationRule";
  name: string;
  object: string;
  /** e.g. "after update", "before insert", "validation". */
  when: string[];
  namespace?: string;
  /** Installed package that owns it, when known. */
  packageName?: string;
}

export interface OrgContext {
  /** Org alias or username passed to `--org`. */
  org: string;
  queriedAt: string;
  /** Record counts for impacted objects. */
  recordCounts: Record<string, number>;
  /** Active users holding each changed permission set or profile. */
  assignments: { kind: "PermissionSet" | "Profile"; name: string; activeUsers: number }[];
  /** Active automation on impacted objects that exists in the org but not in the project. */
  orgOnlyAutomation: OrgAutomation[];
  packages: { namespace?: string; name: string; version: string }[];
  /** Access checks of the dedicated runtime users of affected agents (named by agent, never by username). */
  agentUsers?: AgentUserAccess[];
  /** Queries that failed; the rest of the context is still usable. */
  errors: string[];
}

export interface AgentUserAccess {
  /** Agent name; the user is only ever referred to as "<agent>'s runtime user". */
  agent: string;
  agentLabel?: string;
  status: "checked" | "not found" | "inactive";
  /** Access the affected actions need that the user doesn't have. */
  missing: AccessNeed[];
  /** Apex classes the affected actions call that the user can't run. */
  missingClasses?: string[];
  /** Broad access beyond what the actions need, e.g. "Modify All Data". */
  broad: string[];
}

export interface CommitProvenance {
  sha: string;
  subject: string;
  author: string;
  /** AI tools detected from trailers, markers or bot authors; empty for human-only commits. */
  aiTools: string[];
}

export interface Provenance {
  range: string;
  /** The repository is a shallow clone, so commits before its cut-off are missing. */
  shallow?: boolean;
  commits: number;
  aiAssistedCommits: number;
  tools: string[];
  details: CommitProvenance[];
}

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

export type ChangeType = "added" | "modified" | "deleted" | "renamed";

export interface Change {
  changeType: ChangeType;
  component: ComponentRef;
  previousFile?: string;
  /** Set when a destructive manifest deletes the component: the manifest's path. */
  manifest?: string;
}

export type AutomationKind =
  | "Flow"
  | "ApexTrigger"
  | "ApexClass"
  | "ValidationRule"
  | "RollUpSummary"
  | "LightningComponent"
  | "DuplicateRule"
  | "AssignmentRule"
  | "AutoResponseRule"
  | "EscalationRule"
  | "ApprovalProcess"
  | "Change";

export interface AutomationRef {
  kind: AutomationKind;
  name: string;
  file?: string;
  phase?: Phase;
}

export type Phase =
  | "before-flow"
  | "before-trigger"
  | "validation"
  | "duplicate"
  | "after-trigger"
  | "assignment"
  | "auto-response"
  | "escalation"
  | "after-flow"
  | "rollup";

export interface SaveStep {
  order: number;
  phase: Phase;
  phaseLabel: string;
  automation: AutomationRef;
  writes: Write[];
  notes: string[];
}

export interface SaveProcedure {
  object: string;
  event: SaveEvent;
  steps: SaveStep[];
}

export interface CascadeNode {
  object: string;
  event: SaveEvent;
  via?: AutomationRef;
  depth: number;
  children: CascadeNode[];
  /** The object already appears earlier on this path: re-entry / recursion risk. */
  cycle?: boolean;
  /** A platform event: its subscribers run later, in their own transaction, so the cascade stops here. */
  async?: boolean;
  truncated?: boolean;
}

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  object?: string;
  /** Project-relative files involved; the first is the primary location. */
  files: string[];
  /** 1-based line in the primary file, when known. */
  line?: number;
}

export type TestKind =
  | "agent"
  | "bulk"
  | "validation-collision"
  | "recursion"
  | "permission-negative"
  | "idempotency"
  | "boundary";

export interface SuggestedTest {
  kind: TestKind;
  object?: string;
  description: string;
  covers: string[];
}

/** Object access a user needs (read is implied). */
export interface AccessNeed {
  object: string;
  /** "read" is implied by the others; it's listed when it's all that's needed (or missing). */
  access: ("read" | "create" | "edit" | "delete")[];
}

/** An agent action the change affects. */
export interface AgentImpact {
  agent: string;
  agentLabel?: string;
  topic?: string;
  action: string;
  actionLabel?: string;
  /** What the action calls. */
  target: { kind: "ApexClass" | "Flow" | "PromptTemplate" | "Other"; name?: string; inProject: boolean };
  /** Why the change affects it, e.g. "it runs changed class OpportunityCloser". */
  reasons: string[];
  /** Objects saved when the action runs, including the cascade. */
  reaches: string[];
  /** An automation cycle its saves run into. */
  cycle?: string[];
  /**
   * Object access its runtime user needs: what a flow saves (flows run as the user), or what an
   * Apex class saves when the class enforces user mode. Apex in system mode needs none.
   */
  needs: AccessNeed[];
  /** Apex class the runtime user needs access to (Apex targets). */
  apexClass?: string;
  /** Apex target runs in system mode: object permissions aren't enforced for its saves. */
  systemMode?: boolean;
  runsAs: "dedicated user" | "signed-in user";
  /** Testing Center tests that expect this action. */
  tests: string[];
  /** All Testing Center tests of the agent. */
  agentTests: string[];
  confirmationRequired: boolean;
  files: string[];
}

export interface Reference {
  from:
    | AutomationRef
    | {
        kind:
          | "FormulaField"
          | "PermissionSet"
          | "Profile"
          | "Layout"
          | "FlexiPage"
          | "OutboundMessage"
          | "Report"
          | "ReportType"
          | "ListView"
          | "EmailTemplate"
          | "QuickAction"
          | "CompactLayout"
          | "FieldSet";
        name: string;
        file?: string;
      };
  to: string;
}

/**
 * How much of the change was analyzed in depth. Types without a dedicated analysis are still
 * recognized and listed here, with the project files that mention them.
 */
export interface Coverage {
  /** Changed components of types analyzed in depth (fields, flows, Apex, permissions, ...). */
  deep: number;
  /** Changed components of every other metadata type. */
  basic: number;
  /** The basic ones by metadata type. */
  basicByType: { type: string; count: number }[];
  /** Project files that mention each basic component (by API name), most useful first. */
  mentions: { component: string; type: string; files: string[]; more: number }[];
}

export interface AnalysisResult {
  schemaVersion: 1;
  generatedAt: string;
  projectDir: string;
  /** Project directory relative to the git root (posix, "" for the root); set when in a git repo. */
  projectPathInRepo?: string;
  base?: string;
  head?: string;
  changes: Change[];
  ignoredFiles: string[];
  references: Reference[];
  impactedObjects: string[];
  saveProcedures: SaveProcedure[];
  cascade: CascadeNode[];
  cycles: string[][];
  findings: Finding[];
  suggestedTests: SuggestedTest[];
  /** Agent actions the change affects (empty when the project has no agents or none are affected). */
  agents: AgentImpact[];
  /** Present when the project's changes include components that are not analyzed in depth. */
  coverage?: Coverage;
  summary: {
    risk: "high" | "medium" | "low";
    changedComponents: number;
    impactedObjects: number;
    automationsInvolved: number;
    cycles: number;
    findingsBySeverity: Record<Severity, number>;
  };
  warnings: string[];
  /** Present when the change was read from a git range. */
  provenance?: Provenance;
  /** Present when analyzed with `--org`: read-only context from a Salesforce org. */
  org?: OrgContext;
  /** The `.preflight.json` applied to the findings (project-relative path). */
  /** The policy file applied (project-relative), the git ref it came from, and its digest. */
  config?: { file: string; ref?: string; sha256?: string };
  /** Present when findings already there before the change were hidden (see baseline.ts). */
  baseline?: { source: string; hidden: number };
  /** Present when the quality gate was evaluated (`--gate`). */
  gate?: GateResult;
}
