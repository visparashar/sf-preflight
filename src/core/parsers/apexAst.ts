// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ApexErrorListener,
  ApexParserFactory,
  ArrayExpressionContext,
  AssignExpressionContext,
  CastExpressionContext,
  ClassBodyDeclarationContext,
  ClassDeclarationContext,
  CondExpressionContext,
  ConstructorDeclarationContext,
  DeleteStatementContext,
  DotExpressionContext,
  DoWhileStatementContext,
  EnhancedForControlContext,
  ExpressionStatementContext,
  FieldDeclarationContext,
  FieldNameContext,
  FormalParameterContext,
  ForStatementContext,
  FromNameListContext,
  IdPrimaryContext,
  InsertStatementContext,
  LocalVariableDeclarationContext,
  MergeStatementContext,
  MethodCallContext,
  MethodCallExpressionContext,
  MethodDeclarationContext,
  NewExpressionContext,
  PrimaryExpressionContext,
  PropertyDeclarationContext,
  QueryContext,
  SoqlPrimaryContext,
  SubExpressionContext,
  SubQueryContext,
  ThisPrimaryContext,
  TriggerUnitContext,
  TypeDeclarationContext,
  type TypeRefContext,
  UndeleteStatementContext,
  UpdateStatementContext,
  UpsertStatementContext,
  VariableDeclaratorContext,
  WhileStatementContext,
} from "@apexdevtools/apex-parser";
import { looksLikeSObject, SYSTEM_CLASSES } from "../standardObjects.js";
import type {
  ApexAnalysis,
  ApexCall,
  ApexMethod,
  Confidence,
  DmlOp,
  LoopIssue,
  SaveEvent,
  SaveResultIssue,
  Timing,
  Write,
} from "../types.js";
import { uniq, uniqBy } from "../util.js";

/**
 * Apex analysis on a real parse tree (@apexdevtools/apex-parser).
 *
 * Resolves the SObject type of DML targets through local variables, parameters, for-each
 * variables, class fields and properties, same-class method return types, casts, `new`,
 * inline SOQL and `Trigger.new/old/newMap/oldMap`. Records every method call with the
 * enclosing method and whether it runs inside a loop, so DML/SOQL hidden behind helper
 * methods (in this or another class) can be found once all classes are parsed.
 */

// Structural view of an ANTLR parse-tree node, so we don't depend on antlr4's types.
interface Node {
  parentCtx?: Node | null;
  children?: Node[] | null;
  start?: { line: number } | null;
  getText(): string;
}

interface TypeInfo {
  /** Element type for collections (List<Account> → Account), otherwise the type itself. */
  name: string;
  collection: boolean;
}

interface Resolved {
  object?: string;
  self?: boolean;
  confidence: Confidence;
  /** Non-SObject type of the expression (for resolving instance method calls). */
  classType?: string;
}

const DATABASE_DML = /^(insert|update|upsert|delete|undelete|merge)(immediate|async)?$/i;
const COLLECTION_PASSTHROUGH = new Set(["values", "get", "clone", "deepclone", "remove"]);
const TRIGGER_VAR = /^trigger\.(new|old|newmap|oldmap)\b/i;

export interface AstOptions {
  projectObjects: Set<string>;
  kind: "class" | "trigger";
}

export interface AstResult extends Omit<ApexAnalysis, "stripped"> {
  name?: string;
  /** Trigger only. */
  triggerObject?: string;
  triggerEvents?: { timing: Timing; event: SaveEvent }[];
  invocable: boolean;
  isTest: boolean;
}

class Collector extends ApexErrorListener {
  errors: { line: number; message: string }[] = [];
  apexSyntaxError(line: number, _column: number, msg: string): void {
    this.errors.push({ line, message: msg });
  }
}

/** ANTLR prediction modes (antlr4 PredictionMode.SLL / LL). */
const SLL = 0;

function parse(source: string, kind: AstOptions["kind"], sll: boolean) {
  const collector = new Collector();
  const { parser } = ApexParserFactory.createLexerAndParser(source, collector);
  if (sll) (parser as unknown as { _interp: { predictionMode: number } })._interp.predictionMode = SLL;
  const root = (kind === "trigger" ? parser.triggerUnit() : parser.compilationUnit()) as unknown as Node;
  return { root, errors: collector.errors };
}

/**
 * Parse and analyze Apex source, or return the syntax errors. Parses with the fast SLL
 * strategy first and only falls back to full LL prediction when SLL reports errors, which
 * gives the same tree as LL alone at a fraction of the cost.
 */
export function analyzeApexAst(
  source: string,
  opts: AstOptions,
): AstResult | { errors: { line: number; message: string }[] } {
  let result = parse(source, opts.kind, true);
  if (result.errors.length) result = parse(source, opts.kind, false);
  if (result.errors.length) return { errors: result.errors };
  return new Analyzer(source, opts).run(result.root);
}

class Analyzer {
  private readonly lines: string[];
  private readonly writes: Write[] = [];
  private readonly reads: string[] = [];
  private readonly classRefs = new Set<string>();
  private readonly loopIssues: LoopIssue[] = [];
  private readonly saveIssues: SaveResultIssue[] = [];
  private readonly calls: ApexCall[] = [];
  private readonly methods = new Map<string, ApexMethod>();
  private readonly fieldRefs: string[] = [];
  private readonly fieldWrites: string[] = [];
  private unresolvedDml = 0;

  // Symbols
  private readonly classFields = new Map<string, TypeInfo>();
  private readonly returnTypes = new Map<string, TypeInfo>();
  private scope = new Map<string, TypeInfo>();
  private currentClass = "";
  private currentMethod = "<init>";
  private triggerObject?: string;
  private invocable = false;
  private isTest = false;

  constructor(
    source: string,
    private readonly opts: AstOptions,
  ) {
    this.lines = source.split("\n");
  }

  run(root: Node): AstResult {
    let name: string | undefined;
    let triggerEvents: AstResult["triggerEvents"];
    if (root instanceof TriggerUnitContext) {
      const t = root as unknown as TriggerUnitContext;
      name = t.id(0)?.getText();
      this.triggerObject = t.id(1)?.getText();
      this.currentClass = name ?? "";
      triggerEvents = t.triggerCase_list().map((c) => ({
        timing: (c.BEFORE() ? "before" : "after") as Timing,
        event: (c.INSERT() ? "insert" : c.UPDATE() ? "update" : c.DELETE() ? "delete" : "undelete") as SaveEvent,
      }));
      this.currentMethod = "<trigger>";
      this.method("<trigger>", t.start?.line ?? 1);
    } else {
      const firstClass = findFirst(root, (n) => n instanceof ClassDeclarationContext) as
        | ClassDeclarationContext
        | undefined;
      name = firstClass?.id()?.getText();
      this.currentClass = name ?? "";
      const typeDecl = findFirst(root, (n) => n instanceof TypeDeclarationContext) as
        | TypeDeclarationContext
        | undefined;
      this.isTest = !!typeDecl?.modifier_list().some((m) => /^@istest\b/i.test(m.getText()));
    }

    this.declarePass(root);
    this.visit(root);

    return {
      name,
      triggerObject: this.triggerObject,
      triggerEvents,
      writes: uniqBy(this.writes, (w) => `${w.object.toLowerCase()}|${w.op}|${w.via}`),
      reads: uniq(this.reads),
      classRefs: [...this.classRefs].filter((c) => c.toLowerCase() !== this.currentClass.toLowerCase()),
      loopIssues: uniqBy(this.loopIssues, (l) => `${l.kind}|${l.line}|${l.via ?? ""}`).sort((a, b) => a.line - b.line),
      saveIssues: uniqBy(this.saveIssues, (s) => `${s.line}|${s.op}`).sort((a, b) => a.line - b.line),
      unresolvedDml: this.unresolvedDml,
      calls: this.calls,
      methods: [...this.methods.values()],
      fieldRefs: uniq(this.fieldRefs),
      fieldWrites: uniq(this.fieldWrites),
      parser: "ast",
      invocable: this.invocable,
      isTest: this.isTest,
    };
  }

  // ------------------------------------------------------------------------------------
  // Pass 1: class fields, properties and method return types (declaration order agnostic)
  // ------------------------------------------------------------------------------------
  private declarePass(root: Node): void {
    walk(root, (n) => {
      if (n instanceof FieldDeclarationContext) {
        const t = typeOf(n.typeRef());
        for (const d of n.variableDeclarators().variableDeclarator_list())
          this.classFields.set(lc(d.id().getText()), t);
      } else if (n instanceof PropertyDeclarationContext) {
        this.classFields.set(lc(n.id().getText()), typeOf(n.typeRef()));
      } else if (n instanceof MethodDeclarationContext && n.typeRef()) {
        this.returnTypes.set(lc(n.id().getText()), typeOf(n.typeRef()));
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // Pass 2: analysis
  // ------------------------------------------------------------------------------------
  private visit(n: Node): void {
    if (n instanceof MethodDeclarationContext || n instanceof ConstructorDeclarationContext) {
      this.enterMethod(n);
      return;
    }
    if (n instanceof FormalParameterContext) {
      this.scope.set(lc(n.id().getText()), typeOf(n.typeRef()));
    } else if (n instanceof LocalVariableDeclarationContext) {
      const t = typeOf(n.typeRef());
      for (const d of n.variableDeclarators().variableDeclarator_list()) this.scope.set(lc(d.id().getText()), t);
    } else if (n instanceof EnhancedForControlContext) {
      this.scope.set(lc(n.id().getText()), typeOf(n.typeRef()));
    } else if (
      n instanceof InsertStatementContext ||
      n instanceof UpdateStatementContext ||
      n instanceof UpsertStatementContext ||
      n instanceof DeleteStatementContext ||
      n instanceof UndeleteStatementContext ||
      n instanceof MergeStatementContext
    ) {
      this.dmlStatement(n);
    } else if (n instanceof QueryContext && !(n.parentCtx instanceof SubQueryContext)) {
      this.query(n);
    } else if (n instanceof DotExpressionContext) {
      this.dotExpression(n);
    } else if (n instanceof MethodCallContext) {
      const id = n.id()?.getText();
      if (id) this.recordCall(this.currentClass, id, n);
    } else if (n instanceof NewExpressionContext) {
      const created = createdType(n);
      if (created && !created.collection && this.isClassName(created.name)) this.classRefs.add(created.name);
    } else if (n instanceof AssignExpressionContext) {
      this.assignment(n);
    }
    for (const c of n.children ?? []) this.visit(c);
  }

  private enterMethod(n: MethodDeclarationContext | ConstructorDeclarationContext): void {
    const name =
      n instanceof MethodDeclarationContext
        ? n.id().getText()
        : (n.qualifiedName().getText().split(".").pop() ?? "<init>");
    const decl = closest(n as unknown as Node, (p) => p instanceof ClassBodyDeclarationContext) as
      | ClassBodyDeclarationContext
      | undefined;
    const annotations = (decl?.modifier_list?.() ?? []).map((m) => m.getText().toLowerCase());
    const method = this.method(name, n.start?.line ?? 1);
    if (annotations.some((a) => a.startsWith("@invocablemethod"))) {
      method.invocable = true;
      this.invocable = true;
    }
    if (annotations.includes("static")) method.isStatic = true;
    method.params = (n.formalParameters().formalParameterList()?.formalParameter_list() ?? []).map((p) =>
      p.typeRef().getText(),
    );
    const savedScope = this.scope;
    const savedMethod = this.currentMethod;
    this.scope = new Map();
    this.currentMethod = name;
    for (const c of (n as unknown as Node).children ?? []) this.visit(c);
    this.scope = savedScope;
    this.currentMethod = savedMethod;
  }

  private method(name: string, line: number): ApexMethod {
    const k = lc(name);
    let m = this.methods.get(k);
    if (!m) {
      m = { name, line, invocable: false, dml: false, soql: false };
      this.methods.set(k, m);
    }
    return m;
  }

  private current(): ApexMethod {
    return this.method(this.currentMethod, 1);
  }

  // --- DML ------------------------------------------------------------------------------
  private dmlStatement(
    n:
      | InsertStatementContext
      | UpdateStatementContext
      | UpsertStatementContext
      | DeleteStatementContext
      | UndeleteStatementContext
      | MergeStatementContext,
  ): void {
    const op: DmlOp =
      n instanceof InsertStatementContext
        ? "insert"
        : n instanceof UpsertStatementContext
          ? "upsert"
          : n instanceof DeleteStatementContext
            ? "delete"
            : n instanceof UndeleteStatementContext
              ? "undelete"
              : "update";
    const expr = n instanceof MergeStatementContext ? n.expression(0) : n.expression();
    this.dml(op, expr as unknown as Node, n as unknown as Node);
  }

  private dml(op: DmlOp, target: Node | undefined, at: Node): void {
    const line = at.start?.line ?? 1;
    this.current().dml = true;
    if (inLoop(at)) this.loopIssues.push({ kind: "dml-in-loop", line, snippet: this.snippet(line) });
    const r = target ? this.resolve(target) : { confidence: "low" as Confidence };
    if (!r.object) {
      this.unresolvedDml++;
      return;
    }
    this.writes.push({
      object: r.object,
      op,
      selfUpdate: r.self || undefined,
      via: `line ${line}`,
      confidence: r.confidence,
    });
  }

  // --- SOQL -----------------------------------------------------------------------------
  private query(q: QueryContext): void {
    const from = q.fromNameList()?.fieldName(0)?.getText();
    const line = q.start?.line ?? 1;
    this.current().soql = true;
    if (from) {
      this.reads.push(from);
      walk(q as unknown as Node, (n) => {
        if (n instanceof SubQueryContext) return false;
        if (n instanceof FieldNameContext && !(n.parentCtx instanceof FromNameListContext)) {
          this.fieldRefs.push(`${from}.${n.getText()}`);
        }
        return true;
      });
    }
    if (inLoop(q as unknown as Node)) this.loopIssues.push({ kind: "soql-in-loop", line, snippet: this.snippet(line) });
  }

  // --- Calls, Database.*, EventBus.publish and field access -------------------------------
  private dotExpression(n: DotExpressionContext): void {
    const left = n.expression() as unknown as Node;
    const call = n.dotMethodCall();
    const leftText = left.getText();
    if (call) {
      const method = call.anyId().getText();
      const firstArg = call.expressionList()?.expression(0) as unknown as Node | undefined;
      if (/^database$/i.test(leftText) && DATABASE_DML.test(method)) {
        const op = method.toLowerCase().replace(/(immediate|async)$/, "") as DmlOp | "merge";
        this.saveResult(n, call.expressionList(), method);
        this.dml(op === "merge" ? "update" : op, firstArg, n as unknown as Node);
        return;
      }
      if (/^eventbus$/i.test(leftText) && /^publish$/i.test(method)) {
        // Publishing platform events fires their after-insert subscribers.
        const r = firstArg ? this.resolve(firstArg) : undefined;
        if (r?.object) {
          this.writes.push({
            object: r.object,
            op: "insert",
            via: `line ${n.start?.line ?? 1} (EventBus.publish)`,
            confidence: r.confidence,
          });
        }
        return;
      }
      const target = this.callTarget(left);
      if (target) this.recordCall(target, method, n as unknown as Node);
      return;
    }
    // Field access: acc.Field__c
    const field = n.anyId()?.getText();
    if (field && left instanceof PrimaryExpressionContext && left.primary() instanceof IdPrimaryContext) {
      const t = this.lookup(leftText);
      if (t && !t.collection && looksLikeSObject(t.name, this.opts.projectObjects)) {
        this.fieldRefs.push(`${t.name}.${field}`);
      } else if (!t && /__c$/i.test(field)) {
        this.fieldRefs.push(`*.${field}`);
      }
    }
  }

  /**
   * `Database.update(records, false)` saves what it can and reports the rest in its result. If the
   * result is thrown away, or kept in a variable nothing reads, failed records are silently skipped.
   */
  private saveResult(call: DotExpressionContext, args: { expression_list(): unknown[] } | undefined, method: string) {
    if (/^merge$/i.test(method)) return;
    const exprs = (args?.expression_list() ?? []) as Node[];
    if (!exprs.slice(1).some((e) => /^false$/i.test(e.getText()))) return;
    const line = call.start?.line ?? 1;
    const parent = (call as unknown as Node).parentCtx;
    let kind: SaveResultIssue["kind"] | undefined;
    if (parent instanceof ExpressionStatementContext) kind = "discarded";
    else {
      let name: string | undefined;
      let assign: Node | undefined;
      if (parent instanceof VariableDeclaratorContext) name = parent.id().getText();
      else if (parent instanceof AssignExpressionContext) {
        const left = parent.expression(0) as unknown as Node;
        if (left instanceof PrimaryExpressionContext && left.primary() instanceof IdPrimaryContext) {
          name = left.getText();
          assign = left;
        }
      }
      if (name) {
        const method = closest(
          call as unknown as Node,
          (p) => p instanceof MethodDeclarationContext || p instanceof ConstructorDeclarationContext,
        );
        let uses = 0;
        if (method)
          walk(method, (n) => {
            if (n instanceof IdPrimaryContext && lc(n.id().getText()) === lc(name!)) uses++;
            return true;
          });
        // An assignment's own left side is not a use.
        if (method && uses <= (assign ? 1 : 0)) kind = "unread";
      }
    }
    if (kind) this.saveIssues.push({ op: method.toLowerCase(), line, snippet: this.snippet(line), kind });
  }

  private callTarget(left: Node): string | undefined {
    if (left instanceof PrimaryExpressionContext) {
      const p = left.primary();
      if (p instanceof ThisPrimaryContext) return this.currentClass;
      if (p instanceof IdPrimaryContext) {
        const id = p.id().getText();
        const t = this.lookup(id);
        if (t) return !t.collection && this.isClassName(t.name) ? t.name : undefined;
        return this.isClassName(id) ? id : undefined; // static call: ClassName.method()
      }
    }
    if (left instanceof NewExpressionContext) {
      const created = createdType(left);
      return created && !created.collection && this.isClassName(created.name) ? created.name : undefined;
    }
    return undefined;
  }

  private recordCall(cls: string, method: string, at: Node): void {
    if (this.isClassName(cls) && lc(cls) !== lc(this.currentClass)) this.classRefs.add(cls);
    const line = at.start?.line ?? 1;
    this.calls.push({
      cls: lc(cls) === lc(this.currentClass) ? undefined : cls,
      method,
      line,
      inLoop: inLoop(at),
      from: this.currentMethod,
      snippet: this.snippet(line),
    });
  }

  private assignment(n: AssignExpressionContext): void {
    const left = n.expression(0) as unknown as Node;
    if (left instanceof DotExpressionContext && !left.dotMethodCall()) {
      const root = left.expression() as unknown as Node;
      const t = root instanceof PrimaryExpressionContext ? this.lookup(root.getText()) : undefined;
      if (t && !t.collection && looksLikeSObject(t.name, this.opts.projectObjects)) {
        this.fieldWrites.push(`${t.name}.${left.anyId().getText()}`);
      }
      return;
    }
    // new Account(Name = 'x', Field__c = 1)
    if (left instanceof PrimaryExpressionContext && left.primary() instanceof IdPrimaryContext) {
      const creator = closest(n as unknown as Node, (p) => p instanceof NewExpressionContext, 6) as
        | NewExpressionContext
        | undefined;
      const created = creator ? createdType(creator) : undefined;
      if (created && !created.collection && looksLikeSObject(created.name, this.opts.projectObjects)) {
        const f = `${created.name}.${left.getText()}`;
        this.fieldWrites.push(f);
        this.fieldRefs.push(f);
      }
    }
  }

  // --- Type resolution --------------------------------------------------------------------
  private lookup(name: string): TypeInfo | undefined {
    const k = lc(name);
    return this.scope.get(k) ?? this.classFields.get(k);
  }

  private sobject(t: TypeInfo | undefined, confidence: Confidence): Resolved {
    if (!t) return { confidence: "low" };
    if (looksLikeSObject(t.name, this.opts.projectObjects)) return { object: t.name, confidence };
    return { confidence: "low", classType: t.collection ? undefined : t.name };
  }

  private resolve(e: Node): Resolved {
    const text = e.getText();
    if (TRIGGER_VAR.test(text) && this.triggerObject) {
      return { object: this.triggerObject, self: true, confidence: "high" };
    }
    if (e instanceof SubExpressionContext) return this.resolve(e.expression() as unknown as Node);
    if (e instanceof CastExpressionContext) return this.sobject(typeOf(e.typeRef()), "high");
    if (e instanceof NewExpressionContext) return this.sobject(createdType(e), "high");
    if (e instanceof ArrayExpressionContext) return this.resolve(e.expression(0) as unknown as Node);
    if (e instanceof CondExpressionContext) {
      const a = this.resolve(e.expression(1) as unknown as Node);
      return a.object ? a : this.resolve(e.expression(2) as unknown as Node);
    }
    if (e instanceof PrimaryExpressionContext) {
      const p = e.primary();
      if (p instanceof SoqlPrimaryContext) {
        const from = p.soqlLiteral().query().fromNameList()?.fieldName(0)?.getText();
        return from ? { object: from, confidence: "high" } : { confidence: "low" };
      }
      if (p instanceof IdPrimaryContext) return this.sobject(this.lookup(p.id().getText()), "medium");
      return { confidence: "low" };
    }
    if (e instanceof MethodCallExpressionContext) {
      const id = e.methodCall().id()?.getText();
      return id ? this.sobject(this.returnTypes.get(lc(id)), "medium") : { confidence: "low" };
    }
    if (e instanceof DotExpressionContext) {
      const left = e.expression() as unknown as Node;
      // this.field
      if (left instanceof PrimaryExpressionContext && left.primary() instanceof ThisPrimaryContext && e.anyId()) {
        return this.sobject(this.classFields.get(lc(e.anyId().getText())), "medium");
      }
      // map.values(), list.clone(), this.helper()
      const call = e.dotMethodCall();
      if (call) {
        if (left instanceof PrimaryExpressionContext && left.primary() instanceof ThisPrimaryContext) {
          return this.sobject(this.returnTypes.get(lc(call.anyId().getText())), "medium");
        }
        if (COLLECTION_PASSTHROUGH.has(lc(call.anyId().getText()))) {
          const inner = this.resolve(left);
          if (inner.object) return { ...inner, confidence: inner.self ? "high" : "medium" };
        }
      }
      return { confidence: "low" };
    }
    return { confidence: "low" };
  }

  private isClassName(name: string): boolean {
    const k = lc(name);
    return !SYSTEM_CLASSES.has(k) && !looksLikeSObject(name, this.opts.projectObjects) && /^[A-Za-z]\w*$/.test(name);
  }

  private snippet(line: number): string {
    return (this.lines[line - 1] ?? "").trim();
  }
}

// ----------------------------------------------------------------------------------------
// Tree helpers
// ----------------------------------------------------------------------------------------

function lc(s: string): string {
  return s.toLowerCase();
}

/** Depth-first walk; return false from `fn` to skip a node's children. */
function walk(n: Node, fn: (n: Node) => unknown): void {
  if (fn(n) === false) return;
  for (const c of n.children ?? []) walk(c, fn);
}

function findFirst(n: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

function closest(n: Node, pred: (n: Node) => boolean, maxDepth = 50): Node | undefined {
  let p = n.parentCtx;
  for (let i = 0; p && i < maxDepth; i++, p = p.parentCtx) if (pred(p)) return p;
  return undefined;
}

/**
 * True when `n` runs once per iteration of an enclosing loop. The collection expression of a
 * for-each / SOQL-for loop runs once, so it does not count.
 */
export function inLoop(n: Node): boolean {
  let child: Node = n;
  for (let p = n.parentCtx; p; child = p, p = p.parentCtx) {
    if (p instanceof ForStatementContext && child === (p.statement() as unknown as Node)) return true;
    if (p instanceof WhileStatementContext) return true;
    if (p instanceof DoWhileStatementContext) return true;
    if (p instanceof MethodDeclarationContext || p instanceof ConstructorDeclarationContext) return false;
  }
  return false;
}

/** Element type of a type reference: List<Account> → Account (collection), Account → Account. */
function typeOf(t: TypeRefContext | null | undefined): TypeInfo {
  if (!t) return { name: "", collection: false };
  const names = t.typeName_list();
  const last = names[names.length - 1];
  const array = !!t.arraySubscripts()?.getText();
  if (!last) return { name: t.getText(), collection: array };
  const args = last.typeArguments()?.typeList()?.typeRef_list() ?? [];
  if (last.LIST() || last.SET()) return { ...typeOf(args[0]), collection: true };
  if (last.MAP()) return { ...typeOf(args[1]), collection: true };
  return { name: last.id()?.getText() ?? last.getText(), collection: array };
}

function createdType(n: NewExpressionContext): TypeInfo | undefined {
  const pairs = n.creator()?.createdName()?.idCreatedNamePair_list() ?? [];
  const last = pairs[pairs.length - 1];
  if (!last) return undefined;
  const id = last.anyId().getText();
  const args = last.typeList()?.typeRef_list() ?? [];
  if (/^(list|set)$/i.test(id)) return { ...typeOf(args[0]), collection: true };
  if (/^map$/i.test(id)) return { ...typeOf(args[1]), collection: true };
  const isArray = !!n.creator()?.arrayCreatorRest();
  return { name: id, collection: isArray };
}

/**
 * Identifies this analyzer's code, so cached results are dropped when it changes. (Hashes the
 * source text of the analyzer and its helpers; a change to a data table elsewhere is covered by
 * CACHE_VERSION in parseCache.ts.)
 */
export const ANALYZER_FINGERPRINT = createHash("sha256")
  .update(
    [Analyzer, analyzeApexAst, parse, walk, findFirst, closest, typeOf, createdType, lc].map(String).join("\u0000"),
  )
  .digest("hex");
