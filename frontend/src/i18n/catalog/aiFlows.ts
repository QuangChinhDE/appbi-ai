import type { ModuleCatalog } from '../messages';

/**
 * AI Flow Studio strings.
 *
 * Node type labels, tool labels and validation messages come from the BACKEND
 * palette (they are derived from what actually exists in code, so hard-coding
 * them here would go stale the moment a tool is added). Everything the UI itself
 * says lives here.
 */
export const aiFlowsCatalog: ModuleCatalog = {
  en: {
    // ── Shell ────────────────────────────────────────────────────────────
    'aiFlows.page.title': 'AI Studio',
    'aiFlows.page.subtitle':
      'Design how the AI analyses your reports — build specialists, wire them into a flow, test it, publish, then assign it to a report. No coding.',
    'aiFlows.tab.assistants': 'Assistants',
    'aiFlows.tab.flows': 'Flows',
    'aiFlows.tab.agents': 'AI specialists',
    'aiFlows.tab.runs': 'Runs & trace',
    'aiFlows.tab.policies': 'Model policies',

    // ── Common ───────────────────────────────────────────────────────────
    'aiFlows.common.save': 'Save',
    'aiFlows.common.saveDraft': 'Save draft',
    'aiFlows.common.saved': 'Saved',
    'aiFlows.common.saving': 'Saving…',
    'aiFlows.common.cancel': 'Cancel',
    'aiFlows.common.close': 'Close',
    'aiFlows.common.delete': 'Delete',
    'aiFlows.common.edit': 'Edit',
    'aiFlows.common.view': 'View',
    'aiFlows.common.open': 'Open',
    'aiFlows.common.clone': 'Duplicate',
    'aiFlows.common.back': 'Back',
    'aiFlows.common.loading': 'Loading…',
    'aiFlows.common.retry': 'Retry',
    'aiFlows.common.search': 'Search…',
    'aiFlows.common.all': 'All',
    'aiFlows.common.none': 'None',
    'aiFlows.common.required': 'Required',
    'aiFlows.common.optional': 'Optional',
    'aiFlows.common.error': 'Something went wrong',

    // ── Status ───────────────────────────────────────────────────────────
    'aiFlows.status.draft': 'Draft',
    'aiFlows.status.ready': 'Ready',
    'aiFlows.status.in_review': 'In review',
    'aiFlows.status.published': 'Live',
    'aiFlows.status.archived': 'Archived',
    'aiFlows.status.builtin': 'Template',

    // ── Flow list ────────────────────────────────────────────────────────
    'aiFlows.flows.title': 'Flows',
    'aiFlows.flows.subtitle': 'Design and manage Multi-AI-Agent procedures',
    'aiFlows.flows.create': 'New flow',
    'aiFlows.flows.empty.title': 'Start from a template',
    'aiFlows.flows.empty.body':
      'A template is a working flow you can duplicate and reword. Faster than a blank canvas, and it teaches the shape.',
    'aiFlows.flows.empty.blank': 'Start from blank',
    'aiFlows.flows.col.flow': 'Flow',
    'aiFlows.flows.col.status': 'Status',
    'aiFlows.flows.col.steps': 'Steps',
    'aiFlows.flows.col.aiSteps': 'AI steps',
    'aiFlows.flows.col.usedBy': 'Used by',
    'aiFlows.flows.col.updated': 'Updated',
    'aiFlows.flows.usedByCount': '{{count}} assistant(s)',
    'aiFlows.flows.rollback': 'Roll back to previous version',
    'aiFlows.flows.deleteConfirm': 'Delete draft {{key}} v{{version}}?',
    'aiFlows.flows.cloned': 'Duplicated — open it to edit',

    // ── Create wizard ────────────────────────────────────────────────────
    'aiFlows.create.title': 'New flow',
    'aiFlows.create.step1': 'How do you want to start?',
    'aiFlows.create.step2': 'Name it',
    'aiFlows.create.fromTemplate': 'From a template',
    'aiFlows.create.fromTemplateHint': 'Recommended — a working flow you can adapt',
    'aiFlows.create.fromExisting': 'Duplicate an existing flow',
    'aiFlows.create.blank': 'Blank flow',
    'aiFlows.create.blankHint': 'Starts with Guard → End only',
    'aiFlows.create.name': 'Flow name',
    'aiFlows.create.key': 'Flow key',
    'aiFlows.create.keyHint': 'Auto-generated from the name. Lowercase, no spaces.',
    'aiFlows.create.description': 'What is this flow for?',
    'aiFlows.create.next': 'Continue',
    'aiFlows.create.submit': 'Create and open',

    // ── Builder header ───────────────────────────────────────────────────
    'aiFlows.builder.steps': '{{count}} steps',
    'aiFlows.builder.readOnly':
      'This is a system template — read only. Duplicate it to make your own.',
    'aiFlows.builder.unsaved': 'Unsaved changes',
    'aiFlows.builder.validate': 'Check',
    'aiFlows.builder.preview': 'Test run',
    'aiFlows.builder.eval': 'Release check',
    'aiFlows.builder.sendReview': 'Send for review',
    'aiFlows.builder.publish': 'Publish',
    'aiFlows.builder.undo': 'Undo',
    'aiFlows.builder.redo': 'Redo',
    'aiFlows.builder.autoLayout': 'Tidy up',
    'aiFlows.builder.fitView': 'Fit to screen',
    'aiFlows.builder.publishBlockedDirty': 'Save before publishing',
    'aiFlows.builder.publishBlockedInvalid': 'Fix the errors first',
    'aiFlows.builder.published': 'Published — assistants using this flow switch over now',
    'aiFlows.builder.overview':
      '{{nodes}} steps · {{ai}} AI calls max · {{tools}} tool calls max · {{seconds}}s · ${{usd}}',
    'aiFlows.builder.selected': '{{count}} selected',

    // ── Palette ──────────────────────────────────────────────────────────
    'aiFlows.palette.title': 'Add a step',
    'aiFlows.palette.tabNodes': 'Steps',
    'aiFlows.palette.tabAgents': 'Specialists',
    'aiFlows.palette.tabTools': 'Tools',
    'aiFlows.palette.hint':
      'Steps marked AI cost money on every run. Green steps run in code and are free.',
    'aiFlows.palette.dragHint': 'Drag onto the canvas, or click to add',
    'aiFlows.palette.badgeAI': 'AI',
    'aiFlows.palette.locked': 'System step — cannot be removed',

    // ── Node inspector ───────────────────────────────────────────────────
    'aiFlows.inspector.empty': 'Select a step to configure it.',
    'aiFlows.inspector.flowSettings': 'Flow settings',
    'aiFlows.inspector.nodeName': 'Step name',
    'aiFlows.inspector.nodeDescription': 'Note for your team',
    'aiFlows.inspector.setEntrypoint': 'Make this the first step',
    'aiFlows.inspector.isEntrypoint': 'First step',
    'aiFlows.inspector.disable': 'Skip this step',
    'aiFlows.inspector.advanced': 'Advanced',
    'aiFlows.inspector.next': 'Next step',
    'aiFlows.inspector.onSuccess': 'If it passes',
    'aiFlows.inspector.onFailure': 'If it fails',
    'aiFlows.inspector.routing': 'Where it goes next',
    'aiFlows.inspector.writes': 'What this step writes',
    'aiFlows.inspector.writesHint':
      'Anything written outside this list is refused at run time — even if the model tries.',
    'aiFlows.inspector.agent': 'AI specialist',
    'aiFlows.inspector.agentHint': 'Only published specialists appear. Edit prompts in the Specialists tab.',
    'aiFlows.inspector.openAgentEditor': 'Open specialist editor',
    'aiFlows.inspector.tools': 'Tools it may use',
    'aiFlows.inspector.depth': 'Depth',
    'aiFlows.inspector.depthAuto': 'Automatic (follows the question)',
    'aiFlows.inspector.depthNormal': 'Quick',
    'aiFlows.inspector.depthThinking': 'Deep',
    'aiFlows.inspector.depthHint':
      '“Automatic” keeps the viewer’s own choice — safest while you are starting out.',
    'aiFlows.inspector.handler': 'What it checks',
    'aiFlows.inspector.tool': 'Tool',
    'aiFlows.inspector.condition': 'Condition',
    'aiFlows.inspector.conditionHint':
      'Form: field operator value. Allowed fields: intent, model_calls, tool_calls, usd, status.',
    'aiFlows.inspector.contextSources': 'Knowledge to load',
    'aiFlows.inspector.contextLocked': 'Always on — cannot be switched off',
    'aiFlows.inspector.contextBudget': 'Token budget',
    'aiFlows.inspector.branches': 'Parallel branches',
    'aiFlows.inspector.reducer': 'How to merge results',
    'aiFlows.inspector.clarifyTemplate': 'Question to ask',
    'aiFlows.inspector.resumeNode': 'Resume at',
    'aiFlows.inspector.verifyOnFail': 'If a number cannot be verified',
    'aiFlows.inspector.verifyFlag': 'Flag it only',
    'aiFlows.inspector.verifyRepair': 'Try to fix once',
    'aiFlows.inspector.verifyStrip': 'Remove the unsupported claim',

    // ── Limits ───────────────────────────────────────────────────────────
    'aiFlows.limits.title': 'Run limits',
    'aiFlows.limits.modelCalls': 'AI calls',
    'aiFlows.limits.toolCalls': 'Tool calls',
    'aiFlows.limits.deadline': 'Time limit (seconds)',
    'aiFlows.limits.maxUsd': 'Cost per run (USD)',
    'aiFlows.limits.loops': 'Repeats per step',
    'aiFlows.limits.colFlow': 'Yours',
    'aiFlows.limits.colGlobal': 'System max',
    'aiFlows.limits.colEffective': 'Applied',
    'aiFlows.limits.clamped': 'Your value is capped by the system limit.',

    // ── Validation ───────────────────────────────────────────────────────
    'aiFlows.validation.title': 'Checks',
    'aiFlows.validation.ok': 'No problems — ready to publish.',
    'aiFlows.validation.errors': '{{count}} must fix',
    'aiFlows.validation.warnings': '{{count}} worth checking',
    'aiFlows.validation.suggestions': '{{count}} suggestions',
    'aiFlows.validation.jumpTo': 'Show me',

    // ── Preview ──────────────────────────────────────────────────────────
    'aiFlows.preview.title': 'Test run',
    'aiFlows.preview.report': 'Run against report',
    'aiFlows.preview.question': 'Question to try',
    'aiFlows.preview.run': 'Run',
    'aiFlows.preview.stop': 'Stop',
    'aiFlows.preview.noLinks':
      'No shared link has the AI assistant switched on yet. Enable it on a report first.',
    'aiFlows.preview.answer': 'Answer',
    'aiFlows.preview.trace': 'Steps',
    'aiFlows.preview.state': 'State',
    'aiFlows.preview.summary': 'Run result',
    'aiFlows.preview.aiCalls': '{{count}} AI calls',
    'aiFlows.preview.toolCalls': '{{count}} tool calls',
    'aiFlows.preview.verified': 'verified {{percent}}%',
    'aiFlows.preview.notVerified': 'nothing to verify',
    'aiFlows.preview.notVerifiedHint':
      'This run called no tools, so no number could be checked against evidence.',
    'aiFlows.preview.runId': 'run id',

    // ── Eval / publish gate ──────────────────────────────────────────────
    'aiFlows.eval.title': 'Release check',
    'aiFlows.eval.run': 'Run checks',
    'aiFlows.eval.passRate': 'Passed {{passed}}/{{total}}',
    'aiFlows.eval.canPublish': 'Ready to publish',
    'aiFlows.eval.cannotPublish': 'Blocked — fix the failing checks',
    'aiFlows.eval.hard': 'Required',
    'aiFlows.eval.soft': 'Advisory',

    // ── Review / publish ─────────────────────────────────────────────────
    'aiFlows.review.title': 'Send for review',
    'aiFlows.review.impact': 'Impact',
    'aiFlows.review.impactBody': '{{assistants}} assistant(s) · {{bindings}} report surface(s)',
    'aiFlows.review.diff': 'What changes',
    'aiFlows.review.added': 'Added',
    'aiFlows.review.removed': 'Removed',
    'aiFlows.review.changed': 'Changed',
    'aiFlows.review.firstPublish': 'First publish — nothing to compare against.',
    'aiFlows.review.confirm': 'I have reviewed the checks and the production impact.',
    'aiFlows.review.submit': 'Send for review',
    'aiFlows.review.sent': 'Sent — it now appears in AI Suggestions for approval',

    // ── Versions ─────────────────────────────────────────────────────────
    'aiFlows.versions.title': 'Version history',
    'aiFlows.versions.rollbackConfirm': 'Roll back to v{{version}}?',
    'aiFlows.versions.rolledBack': 'Rolled back to v{{version}}',

    // ── Agents ───────────────────────────────────────────────────────────
    'aiFlows.agents.title': 'AI specialists',
    'aiFlows.agents.subtitle':
      'A specialist is one AI role: its own instructions, its own tools, its own model tier. Flows are assembled from these.',
    'aiFlows.agents.create': 'New specialist',
    'aiFlows.agents.key': 'Key',
    'aiFlows.agents.name': 'Display name',
    'aiFlows.agents.policy': 'Model tier',
    'aiFlows.agents.prompt': 'Instructions for the AI',
    'aiFlows.agents.promptHint':
      'This decides the tone and the reasoning. Saying what the AI must NOT do (invent numbers, imply causation) works better than only describing the task.',
    'aiFlows.agents.promptTokens': '≈{{count}} tokens',
    'aiFlows.agents.tabPrompt': 'Instructions',
    'aiFlows.agents.tabTools': 'Tools',
    'aiFlows.agents.tabState': 'State access',
    'aiFlows.agents.tabModel': 'Model',
    'aiFlows.agents.tabVersions': 'Versions',
    'aiFlows.agents.canRead': 'Can read',
    'aiFlows.agents.canWrite': 'Can write',
    'aiFlows.agents.providerSupport': 'Provider support',
    'aiFlows.agents.toolsUnsupported': 'This provider cannot call tools',
    'aiFlows.agents.publish': 'Publish specialist',
    'aiFlows.agents.tabSchema': 'Result shape',
    'aiFlows.agents.open': 'Open editor',
    'aiFlows.agents.noPrompt': '(no instructions yet)',
    'aiFlows.agents.deleteConfirm': 'Delete draft specialist {{name}}?',
    'aiFlows.agents.newVersion': 'Saved as v{{version}} — the published version is untouched',
    'aiFlows.agents.keyLocked': 'The key cannot change once the specialist exists.',
    'aiFlows.agents.variables': 'Variables you can insert',
    'aiFlows.agents.readHint':
      'Every specialist can read the question, the knowledge that was loaded, and what earlier steps produced in the same run. Read access needs no declaration.',
    'aiFlows.agents.modelHint':
      'The model that actually runs depends on the provider of the key that report uses.',
    'aiFlows.agents.schemaHint':
      'Leave this empty if the step just returns prose. Declaring a shape lets the next step read the result reliably instead of parsing sentences.',
    'aiFlows.agents.schemaSimple': 'Simple mode',
    'aiFlows.agents.schemaAddField': 'Add field',
    'aiFlows.agents.fieldName': 'field name',
    'aiFlows.agents.fieldDesc': 'description',
    'aiFlows.agents.fieldRequired': 'required',
    'aiFlows.agents.jsonValid': 'Valid JSON',
    'aiFlows.agents.lintTitle': 'Prompt review',
    'aiFlows.agents.lint.empty': 'No instructions yet.',
    'aiFlows.agents.lint.tooLong':
      'Very long prompt — models tend to drop instructions buried in the middle.',
    'aiFlows.agents.lint.noProhibition':
      'Nothing says what the AI must NOT do. Forbidding invented numbers works better than describing the task.',
    'aiFlows.agents.lint.noCitation': 'No requirement to cite a source for each figure.',
    'aiFlows.agents.lint.absolutes':
      'Absolute words (“always”, “certainly”) push the model into overclaiming.',
    'aiFlows.agents.lint.unknownVar':
      'These variables do not exist: {{names}} — they will print literally.',
    'aiFlows.agents.var.question': 'The viewer’s question',
    'aiFlows.agents.var.dashboard_name': 'Report name',
    'aiFlows.agents.var.context_block': 'The knowledge that was loaded',
    'aiFlows.agents.var.findings': 'Findings from the previous step',
    'aiFlows.agents.var.plan': 'The analysis plan',
    'aiFlows.agents.var.filters': 'Filters currently applied',

    // ── Export / import ──────────────────────────────────────────────────
    'aiFlows.port.export': 'Export',
    'aiFlows.port.exported': 'Downloaded — the bundle carries the flow and its specialists',
    'aiFlows.port.import': 'Import',
    'aiFlows.port.importTitle': 'Import a flow bundle',
    'aiFlows.port.pick': 'Choose a .json bundle',
    'aiFlows.port.badFile': 'That file is not a flow bundle.',
    'aiFlows.port.fatal': 'Cannot import into this deployment',
    'aiFlows.port.warnings': 'Worth knowing',
    'aiFlows.port.summary': '{{name}} · {{count}} steps',
    'aiFlows.port.newKey': 'Key to import as',
    'aiFlows.port.draftNotice':
      'It lands as a Draft. Nothing serves traffic until you test it here and publish it.',
    'aiFlows.port.confirm': 'Import as draft',
    'aiFlows.port.done': 'Imported as {{key}} — open it to review',

    // ── Run detail ───────────────────────────────────────────────────────
    'aiFlows.runs.tabCanvas': 'On the canvas',
    'aiFlows.runs.tabSteps': 'Step list',
    'aiFlows.runs.tabEvidence': 'Evidence',
    'aiFlows.runs.canvasHint':
      'The flow as it was published, with the path this run actually took highlighted.',
    'aiFlows.runs.flowGone': 'That flow version no longer exists — showing the step list instead.',
    'aiFlows.runs.answer': 'Answer given',
    'aiFlows.runs.notRun': 'not reached',
    'aiFlows.runs.endedHere': 'The run finished here.',

    // ── Command palette ──────────────────────────────────────────────────
    'aiFlows.cmd.placeholder': 'Type a command or a flow name…',
    'aiFlows.cmd.empty': 'Nothing matches.',
    'aiFlows.cmd.groupGo': 'Go to',
    'aiFlows.cmd.groupDo': 'Do',
    'aiFlows.cmd.groupFlows': 'Open a flow',
    'aiFlows.cmd.hint': 'Press {{keys}} anywhere in AI Studio',
    'aiFlows.shortcuts.title': 'Keyboard shortcuts',
    'aiFlows.shortcuts.palette': 'Command palette',
    'aiFlows.shortcuts.save': 'Save draft',
    'aiFlows.shortcuts.undo': 'Undo / redo',
    'aiFlows.shortcuts.delete': 'Delete selected step',
    'aiFlows.shortcuts.layout': 'Tidy the layout',
    'aiFlows.shortcuts.validate': 'Open the checks panel',
    'aiFlows.shortcuts.preview': 'Open the test-run panel',
    'aiFlows.shortcuts.help': 'This list',

    // ── Assistants ───────────────────────────────────────────────────────
    'aiFlows.assistants.title': 'Assistants',
    'aiFlows.assistants.subtitle':
      'An assistant is one chatbot. You say which kinds of question run which flow, then attach it to specific reports.',
    'aiFlows.assistants.create': 'New assistant',
    'aiFlows.assistants.empty':
      'No assistants yet — reports are using the system default flow. Create one to give a report its own.',
    'aiFlows.assistants.routing': 'Routing',
    'aiFlows.assistants.routingHint':
      'The last row must be “*” or some questions will have no flow to handle them.',
    'aiFlows.assistants.colPriority': 'Priority',
    'aiFlows.assistants.colIntent': 'When the question is',
    'aiFlows.assistants.colFlow': 'Run this flow',
    'aiFlows.assistants.colEnabled': 'On',
    'aiFlows.assistants.addRule': 'Add rule',
    'aiFlows.assistants.serving': 'Serving',
    'aiFlows.assistants.notServing': 'Not attached to any report',
    'aiFlows.assistants.addBinding': 'Attach a report',
    'aiFlows.assistants.bindingNeedsFull':
      'Attaching an assistant to a live report needs the “full” permission.',
    'aiFlows.assistants.surfaceLink': 'Shared link',
    'aiFlows.assistants.surfaceDashboard': 'Dashboard',
    'aiFlows.assistants.surfaceGlobal': 'System default',
    'aiFlows.assistants.hierarchy': 'Which assistant wins',
    'aiFlows.assistants.hierarchyBody':
      'Shared link → Dashboard → System default → built-in flow. The most specific match wins.',
    'aiFlows.assistants.budget': 'Budget',
    'aiFlows.assistants.budgetDay': 'Cost per day (USD)',
    'aiFlows.assistants.budgetHour': 'Questions per hour',
    'aiFlows.assistants.knowledge': 'Knowledge it may use',
    'aiFlows.assistants.status': 'Status',
    'aiFlows.assistants.statusDraft': 'Draft (not serving)',
    'aiFlows.assistants.statusPublished': 'On (serving)',
    'aiFlows.assistants.open': 'Configure',
    'aiFlows.assistants.deleteConfirm': 'Delete assistant “{{name}}”?',
    'aiFlows.assistants.tabRouting': 'Routing',
    'aiFlows.assistants.tabBudget': 'Budget',
    'aiFlows.assistants.tabKnowledge': 'Knowledge',
    'aiFlows.assistants.tabBindings': 'Reports served',
    'aiFlows.assistants.dragHint':
      'Rules are matched top to bottom — the first match wins. Drag to reorder.',
    'aiFlows.assistants.moveUp': 'Move up',
    'aiFlows.assistants.moveDown': 'Move down',
    'aiFlows.assistants.wildcardLocked':
      'The catch-all stays last. A rule below it could never be reached.',
    'aiFlows.assistants.wildcardMissing':
      'No catch-all rule. Questions that match nothing will fall back to the built-in flow.',
    'aiFlows.assistants.wildcardLabel': 'anything else',
    'aiFlows.assistants.unreachable': 'Never reached — an earlier rule already covers this.',
    'aiFlows.assistants.effective': 'What actually answers',
    'aiFlows.assistants.effectiveHint':
      'Resolved through the real binding hierarchy, so you are not simulating it in your head.',
    'aiFlows.assistants.effectivePick': 'Check a surface',
    'aiFlows.assistants.effectiveNone':
      'Nothing is bound — this surface falls back to the built-in assistant.',
    'aiFlows.assistants.effectiveMine': 'This assistant answers',
    'aiFlows.assistants.effectiveOther': 'A different assistant wins here: {{key}}',
    'aiFlows.assistants.effectiveVia': 'matched on {{source}}',
    'aiFlows.assistants.estimate': 'At this budget you get roughly',
    'aiFlows.assistants.estimateBody':
      '≈{{turns}} questions/day at ~${{perTurn}} each. The hourly cap stops a burst before the daily cap can be spent in one go.',
    'aiFlows.assistants.estimateNoCap': 'No daily cap — spend is unbounded.',
    'aiFlows.assistants.budgetHint':
      'Viewers using their own key are never blocked on cost — this caps the org key only.',

    // ── Canary ───────────────────────────────────────────────────────────
    'aiFlows.canary.toggle': 'Try a candidate flow on some viewers',
    'aiFlows.canary.title': 'Candidate',
    'aiFlows.canary.pick': '— choose a candidate flow —',
    'aiFlows.canary.hint':
      '{{percent}}% of viewers get the candidate; the rest keep the flow above. A viewer stays on whichever they got for the whole conversation.',
    'aiFlows.canary.sameFlow': 'The candidate is the same flow — nothing is being compared.',
    'aiFlows.canary.arm': 'Arm',
    'aiFlows.canary.primary': 'Current',
    'aiFlows.canary.candidate': 'Candidate',
    'aiFlows.canary.runs': 'Runs',
    'aiFlows.canary.usd': 'Cost/run',
    'aiFlows.canary.latency': 'Median',
    'aiFlows.canary.verified': 'Verified',
    'aiFlows.canary.errors': 'Errors',
    'aiFlows.canary.thinData':
      'Fewer than 20 runs on one arm — too little to conclude anything yet. Test runs are excluded.',

    // ── Runs ─────────────────────────────────────────────────────────────
    'aiFlows.runs.title': 'Runs & trace',
    'aiFlows.runs.subtitle':
      'Every question a viewer asked. Open one to see which steps ran, what they called, and whether every number traces back to evidence.',
    'aiFlows.runs.empty': 'No runs recorded yet.',
    'aiFlows.runs.refresh': 'Refresh',
    'aiFlows.runs.colTime': 'When',
    'aiFlows.runs.colQuestion': 'Question',
    'aiFlows.runs.colFlow': 'Flow',
    'aiFlows.runs.colVerification': 'Verified',
    'aiFlows.runs.colCost': 'Cost',
    'aiFlows.runs.colLatency': 'Time',
    'aiFlows.runs.modePreview': 'test',
    'aiFlows.runs.detail': 'Run detail',
    'aiFlows.runs.stepsRan': 'Steps that ran',
    'aiFlows.runs.evidence': 'Evidence',
    'aiFlows.runs.evidenceHint': 'Every number in the answer must match a row here',
    'aiFlows.runs.noEvidence': 'This run called no tools.',

    // ── Model policies ───────────────────────────────────────────────────
    'aiFlows.policies.title': 'Model policies',
    'aiFlows.policies.subtitle':
      'Which model each tier maps to, per provider. Kept here so a retired vendor model is a settings change, not a deploy.',
    'aiFlows.policies.colPolicy': 'Tier',
    'aiFlows.policies.colProvider': 'Provider',
    'aiFlows.policies.colModel': 'Model',
    'aiFlows.policies.colTools': 'Tool calling',
    'aiFlows.policies.colEnabled': 'Enabled',

    // ── Permissions / errors ─────────────────────────────────────────────
    'aiFlows.perm.readOnly': 'You have view-only access to AI Studio.',
    'aiFlows.perm.needFull': 'This action needs the “full” permission.',
    'aiFlows.error.loadFlow': 'Could not load the flow.',
    'aiFlows.error.conflict':
      'This flow was updated in another tab or by someone else.',
    'aiFlows.error.conflictReload': 'Reload the latest',
    'aiFlows.error.missingAgent': 'Specialist no longer available',
    'aiFlows.error.replace': 'Replace',
    'aiFlows.mobile.unsupported':
      'The flow builder needs a larger screen to edit. You can still view flows, runs and approvals.',
  },

  vi: {
    // ── Shell ────────────────────────────────────────────────────────────
    'aiFlows.page.title': 'Xưởng AI',
    'aiFlows.page.subtitle':
      'Nơi bạn quyết định AI phân tích báo cáo theo cách nào — dựng chuyên gia, nối thành luồng, chạy thử, publish rồi gán cho từng báo cáo. Không cần lập trình.',
    'aiFlows.tab.assistants': 'Trợ lý',
    'aiFlows.tab.flows': 'Luồng phân tích',
    'aiFlows.tab.agents': 'Chuyên gia AI',
    'aiFlows.tab.runs': 'Lượt chạy',
    'aiFlows.tab.policies': 'Cấu hình model',

    // ── Common ───────────────────────────────────────────────────────────
    'aiFlows.common.save': 'Lưu',
    'aiFlows.common.saveDraft': 'Lưu nháp',
    'aiFlows.common.saved': 'Đã lưu',
    'aiFlows.common.saving': 'Đang lưu…',
    'aiFlows.common.cancel': 'Huỷ',
    'aiFlows.common.close': 'Đóng',
    'aiFlows.common.delete': 'Xoá',
    'aiFlows.common.edit': 'Sửa',
    'aiFlows.common.view': 'Xem',
    'aiFlows.common.open': 'Mở',
    'aiFlows.common.clone': 'Nhân bản',
    'aiFlows.common.back': 'Quay lại',
    'aiFlows.common.loading': 'Đang tải…',
    'aiFlows.common.retry': 'Thử lại',
    'aiFlows.common.search': 'Tìm…',
    'aiFlows.common.all': 'Tất cả',
    'aiFlows.common.none': 'Không',
    'aiFlows.common.required': 'Bắt buộc',
    'aiFlows.common.optional': 'Không bắt buộc',
    'aiFlows.common.error': 'Có lỗi xảy ra',

    // ── Status ───────────────────────────────────────────────────────────
    'aiFlows.status.draft': 'Bản nháp',
    'aiFlows.status.ready': 'Sẵn sàng',
    'aiFlows.status.in_review': 'Chờ duyệt',
    'aiFlows.status.published': 'Đang chạy',
    'aiFlows.status.archived': 'Đã lưu trữ',
    'aiFlows.status.builtin': 'Mẫu',

    // ── Flow list ────────────────────────────────────────────────────────
    'aiFlows.flows.title': 'Luồng phân tích',
    'aiFlows.flows.subtitle': 'Thiết kế và quản lý quy trình Multi AI Agent',
    'aiFlows.flows.create': 'Tạo luồng',
    'aiFlows.flows.empty.title': 'Bắt đầu từ một mẫu',
    'aiFlows.flows.empty.body':
      'Mẫu là một luồng đã chạy được, bạn nhân bản rồi sửa lại theo ý mình. Nhanh hơn canvas trắng, và học được cách dựng.',
    'aiFlows.flows.empty.blank': 'Tạo luồng trống',
    'aiFlows.flows.col.flow': 'Luồng',
    'aiFlows.flows.col.status': 'Trạng thái',
    'aiFlows.flows.col.steps': 'Số bước',
    'aiFlows.flows.col.aiSteps': 'Bước AI',
    'aiFlows.flows.col.usedBy': 'Đang dùng bởi',
    'aiFlows.flows.col.updated': 'Cập nhật',
    'aiFlows.flows.usedByCount': '{{count}} trợ lý',
    'aiFlows.flows.rollback': 'Quay lại phiên bản trước',
    'aiFlows.flows.deleteConfirm': 'Xoá bản nháp {{key}} v{{version}}?',
    'aiFlows.flows.cloned': 'Đã nhân bản — mở ra để sửa',

    // ── Create wizard ────────────────────────────────────────────────────
    'aiFlows.create.title': 'Tạo luồng mới',
    'aiFlows.create.step1': 'Bạn muốn bắt đầu thế nào?',
    'aiFlows.create.step2': 'Đặt tên',
    'aiFlows.create.fromTemplate': 'Từ mẫu có sẵn',
    'aiFlows.create.fromTemplateHint': 'Nên chọn — một luồng chạy được để bạn sửa lại',
    'aiFlows.create.fromExisting': 'Nhân bản luồng đang có',
    'aiFlows.create.blank': 'Luồng trống',
    'aiFlows.create.blankHint': 'Chỉ có sẵn Chặn đầu vào → Kết thúc',
    'aiFlows.create.name': 'Tên luồng',
    'aiFlows.create.key': 'Mã luồng',
    'aiFlows.create.keyHint': 'Tự sinh từ tên. Chữ thường, không dấu, không khoảng trắng.',
    'aiFlows.create.description': 'Luồng này dùng để làm gì?',
    'aiFlows.create.next': 'Tiếp tục',
    'aiFlows.create.submit': 'Tạo và mở',

    // ── Builder header ───────────────────────────────────────────────────
    'aiFlows.builder.steps': '{{count}} bước',
    'aiFlows.builder.readOnly':
      'Đây là luồng mẫu của hệ thống — chỉ đọc. Nhân bản để tạo bản của bạn.',
    'aiFlows.builder.unsaved': 'Chưa lưu',
    'aiFlows.builder.validate': 'Kiểm tra',
    'aiFlows.builder.preview': 'Chạy thử',
    'aiFlows.builder.eval': 'Kiểm tra phát hành',
    'aiFlows.builder.sendReview': 'Gửi duyệt',
    'aiFlows.builder.publish': 'Publish',
    'aiFlows.builder.undo': 'Hoàn tác',
    'aiFlows.builder.redo': 'Làm lại',
    'aiFlows.builder.autoLayout': 'Sắp xếp lại',
    'aiFlows.builder.fitView': 'Vừa màn hình',
    'aiFlows.builder.publishBlockedDirty': 'Lưu trước khi publish',
    'aiFlows.builder.publishBlockedInvalid': 'Còn lỗi cần sửa',
    'aiFlows.builder.published': 'Đã publish — các trợ lý đang gán luồng này chuyển sang ngay',
    'aiFlows.builder.overview':
      '{{nodes}} bước · tối đa {{ai}} lượt AI · {{tools}} lần gọi công cụ · {{seconds}}s · ${{usd}}',
    'aiFlows.builder.selected': 'Đã chọn {{count}}',

    // ── Palette ──────────────────────────────────────────────────────────
    'aiFlows.palette.title': 'Thêm bước',
    'aiFlows.palette.tabNodes': 'Loại bước',
    'aiFlows.palette.tabAgents': 'Chuyên gia',
    'aiFlows.palette.tabTools': 'Công cụ',
    'aiFlows.palette.hint':
      'Bước có nhãn AI tốn tiền model mỗi lần chạy. Bước xanh chạy bằng code, không tốn phí.',
    'aiFlows.palette.dragHint': 'Kéo vào canvas, hoặc bấm để thêm',
    'aiFlows.palette.badgeAI': 'AI',
    'aiFlows.palette.locked': 'Bước hệ thống — không xoá được',

    // ── Node inspector ───────────────────────────────────────────────────
    'aiFlows.inspector.empty': 'Chọn một bước để cấu hình.',
    'aiFlows.inspector.flowSettings': 'Cấu hình luồng',
    'aiFlows.inspector.nodeName': 'Tên bước',
    'aiFlows.inspector.nodeDescription': 'Ghi chú cho đồng đội',
    'aiFlows.inspector.setEntrypoint': 'Đặt làm bước đầu tiên',
    'aiFlows.inspector.isEntrypoint': 'Bước đầu tiên',
    'aiFlows.inspector.disable': 'Bỏ qua bước này',
    'aiFlows.inspector.advanced': 'Nâng cao',
    'aiFlows.inspector.next': 'Bước kế',
    'aiFlows.inspector.onSuccess': 'Khi đạt',
    'aiFlows.inspector.onFailure': 'Khi lỗi',
    'aiFlows.inspector.routing': 'Đi tiếp tới đâu',
    'aiFlows.inspector.writes': 'Bước này được ghi gì',
    'aiFlows.inspector.writesHint':
      'Ghi ra ngoài danh sách này sẽ bị hệ thống từ chối khi chạy — kể cả khi model cố ghi.',
    'aiFlows.inspector.agent': 'Chuyên gia AI',
    'aiFlows.inspector.agentHint':
      'Chỉ hiện chuyên gia đã publish. Sửa prompt ở tab Chuyên gia AI.',
    'aiFlows.inspector.openAgentEditor': 'Mở trình soạn chuyên gia',
    'aiFlows.inspector.tools': 'Công cụ được dùng',
    'aiFlows.inspector.depth': 'Độ sâu',
    'aiFlows.inspector.depthAuto': 'Tự động (theo câu hỏi)',
    'aiFlows.inspector.depthNormal': 'Nhanh',
    'aiFlows.inspector.depthThinking': 'Sâu',
    'aiFlows.inspector.depthHint':
      '“Tự động” giữ nguyên lựa chọn của người xem — an toàn nhất khi mới bắt đầu.',
    'aiFlows.inspector.handler': 'Kiểm tra điều gì',
    'aiFlows.inspector.tool': 'Công cụ',
    'aiFlows.inspector.condition': 'Điều kiện',
    'aiFlows.inspector.conditionHint':
      'Dạng: trường toán_tử giá_trị. Trường cho phép: intent, model_calls, tool_calls, usd, status.',
    'aiFlows.inspector.contextSources': 'Tri thức cần nạp',
    'aiFlows.inspector.contextLocked': 'Luôn bật — không tắt được',
    'aiFlows.inspector.contextBudget': 'Hạn mức token',
    'aiFlows.inspector.branches': 'Các nhánh song song',
    'aiFlows.inspector.reducer': 'Cách gộp kết quả',
    'aiFlows.inspector.clarifyTemplate': 'Câu hỏi lại',
    'aiFlows.inspector.resumeNode': 'Chạy tiếp từ',
    'aiFlows.inspector.verifyOnFail': 'Khi một con số không kiểm chứng được',
    'aiFlows.inspector.verifyFlag': 'Chỉ gắn cờ',
    'aiFlows.inspector.verifyRepair': 'Thử sửa một lần',
    'aiFlows.inspector.verifyStrip': 'Bỏ luận điểm không có căn cứ',

    // ── Limits ───────────────────────────────────────────────────────────
    'aiFlows.limits.title': 'Trần cho mỗi lượt chạy',
    'aiFlows.limits.modelCalls': 'Số lượt gọi AI',
    'aiFlows.limits.toolCalls': 'Số lần gọi công cụ',
    'aiFlows.limits.deadline': 'Thời gian tối đa (giây)',
    'aiFlows.limits.maxUsd': 'Chi phí mỗi lượt (USD)',
    'aiFlows.limits.loops': 'Số lần lặp mỗi bước',
    'aiFlows.limits.colFlow': 'Bạn đặt',
    'aiFlows.limits.colGlobal': 'Trần hệ thống',
    'aiFlows.limits.colEffective': 'Thực tế áp dụng',
    'aiFlows.limits.clamped': 'Giá trị của bạn bị kẹp bởi trần hệ thống.',

    // ── Validation ───────────────────────────────────────────────────────
    'aiFlows.validation.title': 'Kiểm tra',
    'aiFlows.validation.ok': 'Không có vấn đề — có thể publish.',
    'aiFlows.validation.errors': '{{count}} lỗi phải sửa',
    'aiFlows.validation.warnings': '{{count}} điểm nên xem lại',
    'aiFlows.validation.suggestions': '{{count}} gợi ý',
    'aiFlows.validation.jumpTo': 'Chỉ cho tôi',

    // ── Preview ──────────────────────────────────────────────────────────
    'aiFlows.preview.title': 'Chạy thử',
    'aiFlows.preview.report': 'Chạy trên báo cáo',
    'aiFlows.preview.question': 'Câu hỏi thử',
    'aiFlows.preview.run': 'Chạy',
    'aiFlows.preview.stop': 'Dừng',
    'aiFlows.preview.noLinks':
      'Chưa có link chia sẻ nào bật trợ lý AI. Hãy bật ở màn hình chia sẻ báo cáo trước.',
    'aiFlows.preview.answer': 'Câu trả lời',
    'aiFlows.preview.trace': 'Các bước',
    'aiFlows.preview.state': 'Trạng thái',
    'aiFlows.preview.summary': 'Kết quả lượt chạy',
    'aiFlows.preview.aiCalls': '{{count}} lượt AI',
    'aiFlows.preview.toolCalls': '{{count}} lần gọi công cụ',
    'aiFlows.preview.verified': 'kiểm chứng {{percent}}%',
    'aiFlows.preview.notVerified': 'không có gì để kiểm chứng',
    'aiFlows.preview.notVerifiedHint':
      'Lượt này không gọi công cụ nào, nên không con số nào được đối chiếu với bằng chứng.',
    'aiFlows.preview.runId': 'mã lượt chạy',

    // ── Eval / publish gate ──────────────────────────────────────────────
    'aiFlows.eval.title': 'Kiểm tra phát hành',
    'aiFlows.eval.run': 'Chạy kiểm tra',
    'aiFlows.eval.passRate': 'Đạt {{passed}}/{{total}}',
    'aiFlows.eval.canPublish': 'Đủ điều kiện publish',
    'aiFlows.eval.cannotPublish': 'Chưa được — còn mục bắt buộc chưa đạt',
    'aiFlows.eval.hard': 'Bắt buộc',
    'aiFlows.eval.soft': 'Khuyến nghị',

    // ── Review / publish ─────────────────────────────────────────────────
    'aiFlows.review.title': 'Gửi duyệt',
    'aiFlows.review.impact': 'Ảnh hưởng',
    'aiFlows.review.impactBody': '{{assistants}} trợ lý · {{bindings}} bề mặt báo cáo',
    'aiFlows.review.diff': 'Thay đổi những gì',
    'aiFlows.review.added': 'Thêm',
    'aiFlows.review.removed': 'Bỏ',
    'aiFlows.review.changed': 'Sửa',
    'aiFlows.review.firstPublish': 'Publish lần đầu — chưa có gì để so sánh.',
    'aiFlows.review.confirm': 'Tôi đã xem kết quả kiểm tra và mức ảnh hưởng tới báo cáo đang chạy.',
    'aiFlows.review.submit': 'Gửi duyệt',
    'aiFlows.review.sent': 'Đã gửi — mục này xuất hiện trong Đề xuất AI để duyệt',

    // ── Versions ─────────────────────────────────────────────────────────
    'aiFlows.versions.title': 'Lịch sử phiên bản',
    'aiFlows.versions.rollbackConfirm': 'Quay lại phiên bản v{{version}}?',
    'aiFlows.versions.rolledBack': 'Đã quay lại v{{version}}',

    // ── Agents ───────────────────────────────────────────────────────────
    'aiFlows.agents.title': 'Chuyên gia AI',
    'aiFlows.agents.subtitle':
      'Một chuyên gia = một vai trò AI: chỉ dẫn riêng, bộ công cụ riêng, mức model riêng. Luồng được lắp từ các chuyên gia này.',
    'aiFlows.agents.create': 'Tạo chuyên gia',
    'aiFlows.agents.key': 'Mã',
    'aiFlows.agents.name': 'Tên hiển thị',
    'aiFlows.agents.policy': 'Mức model',
    'aiFlows.agents.prompt': 'Chỉ dẫn cho AI',
    'aiFlows.agents.promptHint':
      'Đây là phần quyết định giọng và cách suy luận. Nêu rõ điều AI KHÔNG được làm (bịa số, suy diễn nhân quả) hiệu quả hơn nhiều so với chỉ mô tả việc cần làm.',
    'aiFlows.agents.promptTokens': '≈{{count}} token',
    'aiFlows.agents.tabPrompt': 'Chỉ dẫn',
    'aiFlows.agents.tabTools': 'Công cụ',
    'aiFlows.agents.tabState': 'Quyền đọc/ghi',
    'aiFlows.agents.tabModel': 'Model',
    'aiFlows.agents.tabVersions': 'Phiên bản',
    'aiFlows.agents.canRead': 'Được đọc',
    'aiFlows.agents.canWrite': 'Được ghi',
    'aiFlows.agents.providerSupport': 'Nhà cung cấp hỗ trợ',
    'aiFlows.agents.toolsUnsupported': 'Nhà cung cấp này không gọi được công cụ',
    'aiFlows.agents.publish': 'Publish chuyên gia',
    'aiFlows.agents.tabSchema': 'Kết quả trả về',
    'aiFlows.agents.open': 'Mở trình soạn',
    'aiFlows.agents.noPrompt': '(chưa có chỉ dẫn)',
    'aiFlows.agents.deleteConfirm': 'Xoá bản nháp chuyên gia {{name}}?',
    'aiFlows.agents.newVersion': 'Đã lưu thành v{{version}} — bản đang chạy không bị đụng tới',
    'aiFlows.agents.keyLocked': 'Mã không đổi được sau khi chuyên gia đã tồn tại.',
    'aiFlows.agents.variables': 'Biến chèn được',
    'aiFlows.agents.readHint':
      'Mọi chuyên gia đều đọc được câu hỏi, tri thức đã nạp và kết quả của các bước trước trong cùng lượt chạy. Quyền đọc không cần khai báo.',
    'aiFlows.agents.modelHint':
      'Model chạy thật phụ thuộc nhà cung cấp của khoá mà báo cáo đó đang dùng.',
    'aiFlows.agents.schemaHint':
      'Để trống nếu bước này chỉ trả về văn bản. Khai cấu trúc giúp bước sau đọc kết quả một cách chắc chắn thay vì phải bóc tách từ câu chữ.',
    'aiFlows.agents.schemaSimple': 'Chế độ đơn giản',
    'aiFlows.agents.schemaAddField': 'Thêm trường',
    'aiFlows.agents.fieldName': 'tên trường',
    'aiFlows.agents.fieldDesc': 'mô tả',
    'aiFlows.agents.fieldRequired': 'bắt buộc',
    'aiFlows.agents.jsonValid': 'JSON hợp lệ',
    'aiFlows.agents.lintTitle': 'Soát chỉ dẫn',
    'aiFlows.agents.lint.empty': 'Chưa có chỉ dẫn nào.',
    'aiFlows.agents.lint.tooLong':
      'Chỉ dẫn rất dài — model hay bỏ sót đúng những câu nằm ở giữa.',
    'aiFlows.agents.lint.noProhibition':
      'Chưa nêu điều AI KHÔNG được làm. Cấm bịa số hiệu quả hơn nhiều so với mô tả việc cần làm.',
    'aiFlows.agents.lint.noCitation': 'Chưa yêu cầu trích nguồn cho từng con số.',
    'aiFlows.agents.lint.absolutes':
      'Từ tuyệt đối (“chắc chắn”, “luôn luôn”) dễ khiến AI quả quyết quá mức.',
    'aiFlows.agents.lint.unknownVar':
      'Biến không tồn tại: {{names}} — sẽ hiện nguyên văn ra câu trả lời.',
    'aiFlows.agents.var.question': 'Câu hỏi của người xem',
    'aiFlows.agents.var.dashboard_name': 'Tên báo cáo',
    'aiFlows.agents.var.context_block': 'Khối tri thức đã nạp',
    'aiFlows.agents.var.findings': 'Phát hiện từ bước trước',
    'aiFlows.agents.var.plan': 'Kế hoạch phân tích',
    'aiFlows.agents.var.filters': 'Bộ lọc đang áp dụng',

    // ── Export / import ──────────────────────────────────────────────────
    'aiFlows.port.export': 'Xuất file',
    'aiFlows.port.exported': 'Đã tải về — gói này mang theo cả luồng lẫn chuyên gia của nó',
    'aiFlows.port.import': 'Nhập file',
    'aiFlows.port.importTitle': 'Nhập một gói luồng',
    'aiFlows.port.pick': 'Chọn tệp .json',
    'aiFlows.port.badFile': 'Tệp này không phải gói luồng.',
    'aiFlows.port.fatal': 'Không nhập được vào bản cài này',
    'aiFlows.port.warnings': 'Cần biết trước',
    'aiFlows.port.summary': '{{name}} · {{count}} bước',
    'aiFlows.port.newKey': 'Nhập vào với mã',
    'aiFlows.port.draftNotice':
      'Luồng nhập vào luôn ở trạng thái Nháp. Chưa phục vụ ai cho tới khi bạn chạy thử tại đây và publish.',
    'aiFlows.port.confirm': 'Nhập thành bản nháp',
    'aiFlows.port.done': 'Đã nhập thành {{key}} — mở ra để rà lại',

    // ── Run detail ───────────────────────────────────────────────────────
    'aiFlows.runs.tabCanvas': 'Trên sơ đồ',
    'aiFlows.runs.tabSteps': 'Danh sách bước',
    'aiFlows.runs.tabEvidence': 'Bằng chứng',
    'aiFlows.runs.canvasHint':
      'Sơ đồ đúng như lúc publish, tô sáng đường mà lượt chạy này thực sự đi qua.',
    'aiFlows.runs.flowGone': 'Phiên bản luồng đó không còn — hiển thị danh sách bước thay thế.',
    'aiFlows.runs.answer': 'Câu trả lời đã đưa ra',
    'aiFlows.runs.notRun': 'không chạy tới',
    'aiFlows.runs.endedHere': 'Lượt chạy kết thúc tại đây.',

    // ── Command palette ──────────────────────────────────────────────────
    'aiFlows.cmd.placeholder': 'Gõ lệnh hoặc tên luồng…',
    'aiFlows.cmd.empty': 'Không có kết quả.',
    'aiFlows.cmd.groupGo': 'Đi tới',
    'aiFlows.cmd.groupDo': 'Thao tác',
    'aiFlows.cmd.groupFlows': 'Mở luồng',
    'aiFlows.cmd.hint': 'Nhấn {{keys}} ở bất kỳ đâu trong Xưởng AI',
    'aiFlows.shortcuts.title': 'Phím tắt',
    'aiFlows.shortcuts.palette': 'Bảng lệnh',
    'aiFlows.shortcuts.save': 'Lưu nháp',
    'aiFlows.shortcuts.undo': 'Hoàn tác / làm lại',
    'aiFlows.shortcuts.delete': 'Xoá bước đang chọn',
    'aiFlows.shortcuts.layout': 'Sắp xếp lại sơ đồ',
    'aiFlows.shortcuts.validate': 'Mở bảng kiểm tra',
    'aiFlows.shortcuts.preview': 'Mở bảng chạy thử',
    'aiFlows.shortcuts.help': 'Danh sách này',

    // ── Assistants ───────────────────────────────────────────────────────
    'aiFlows.assistants.title': 'Trợ lý',
    'aiFlows.assistants.subtitle':
      'Một trợ lý là một con chatbot. Bạn khai câu hỏi loại nào chạy luồng nào, rồi gán trợ lý đó cho các báo cáo cụ thể.',
    'aiFlows.assistants.create': 'Tạo trợ lý',
    'aiFlows.assistants.empty':
      'Chưa có trợ lý nào — báo cáo đang dùng luồng mặc định của hệ thống. Tạo một trợ lý để chỉ định luồng riêng.',
    'aiFlows.assistants.routing': 'Định tuyến',
    'aiFlows.assistants.routingHint':
      'Dòng cuối phải là “*”, nếu không một số câu hỏi sẽ không có luồng nào xử lý.',
    'aiFlows.assistants.colPriority': 'Thứ tự',
    'aiFlows.assistants.colIntent': 'Khi câu hỏi thuộc loại',
    'aiFlows.assistants.colFlow': 'Chạy luồng',
    'aiFlows.assistants.colEnabled': 'Bật',
    'aiFlows.assistants.addRule': 'Thêm dòng',
    'aiFlows.assistants.serving': 'Đang phục vụ',
    'aiFlows.assistants.notServing': 'Chưa gán báo cáo nào',
    'aiFlows.assistants.addBinding': 'Gán báo cáo',
    'aiFlows.assistants.bindingNeedsFull':
      'Gán trợ lý lên báo cáo đang phát hành cần quyền “full”.',
    'aiFlows.assistants.surfaceLink': 'Link chia sẻ',
    'aiFlows.assistants.surfaceDashboard': 'Dashboard',
    'aiFlows.assistants.surfaceGlobal': 'Mặc định hệ thống',
    'aiFlows.assistants.hierarchy': 'Trợ lý nào được ưu tiên',
    'aiFlows.assistants.hierarchyBody':
      'Link chia sẻ → Dashboard → Mặc định hệ thống → luồng dựng sẵn. Cái cụ thể nhất thắng.',
    'aiFlows.assistants.budget': 'Ngân sách',
    'aiFlows.assistants.budgetDay': 'Chi phí mỗi ngày (USD)',
    'aiFlows.assistants.budgetHour': 'Số câu hỏi mỗi giờ',
    'aiFlows.assistants.knowledge': 'Tri thức được dùng',
    'aiFlows.assistants.status': 'Trạng thái',
    'aiFlows.assistants.statusDraft': 'Nháp (chưa phục vụ)',
    'aiFlows.assistants.statusPublished': 'Bật (đang phục vụ)',
    'aiFlows.assistants.open': 'Cấu hình',
    'aiFlows.assistants.deleteConfirm': 'Xoá trợ lý “{{name}}”?',
    'aiFlows.assistants.tabRouting': 'Định tuyến',
    'aiFlows.assistants.tabBudget': 'Ngân sách',
    'aiFlows.assistants.tabKnowledge': 'Tri thức',
    'aiFlows.assistants.tabBindings': 'Báo cáo phục vụ',
    'aiFlows.assistants.dragHint':
      'Luật khớp từ trên xuống — dòng khớp đầu tiên thắng. Kéo để đổi thứ tự.',
    'aiFlows.assistants.moveUp': 'Lên một dòng',
    'aiFlows.assistants.moveDown': 'Xuống một dòng',
    'aiFlows.assistants.wildcardLocked':
      'Dòng bắt-tất-cả luôn nằm cuối. Dòng nằm dưới nó sẽ không bao giờ tới lượt.',
    'aiFlows.assistants.wildcardMissing':
      'Chưa có dòng bắt-tất-cả. Câu hỏi không khớp luật nào sẽ rơi về luồng dựng sẵn.',
    'aiFlows.assistants.wildcardLabel': 'mọi câu hỏi còn lại',
    'aiFlows.assistants.unreachable': 'Không bao giờ tới lượt — một dòng ở trên đã bao trùm.',
    'aiFlows.assistants.effective': 'Thực tế ai trả lời',
    'aiFlows.assistants.effectiveHint':
      'Tính theo đúng thứ tự ưu tiên thật, để bạn không phải tự suy trong đầu.',
    'aiFlows.assistants.effectivePick': 'Kiểm tra một bề mặt',
    'aiFlows.assistants.effectiveNone':
      'Chưa gán gì — bề mặt này rơi về trợ lý dựng sẵn.',
    'aiFlows.assistants.effectiveMine': 'Trợ lý này trả lời',
    'aiFlows.assistants.effectiveOther': 'Một trợ lý khác thắng ở đây: {{key}}',
    'aiFlows.assistants.effectiveVia': 'khớp ở mức {{source}}',
    'aiFlows.assistants.estimate': 'Với ngân sách này bạn được khoảng',
    'aiFlows.assistants.estimateBody':
      '≈{{turns}} câu hỏi/ngày, mỗi câu ~${{perTurn}}. Trần theo giờ chặn một đợt dồn dập tiêu hết ngân sách ngày trong chốc lát.',
    'aiFlows.assistants.estimateNoCap': 'Chưa đặt trần ngày — chi phí không có giới hạn.',
    'aiFlows.assistants.budgetHint':
      'Người xem dùng khoá riêng của họ không bao giờ bị chặn vì chi phí — trần này chỉ áp cho khoá của tổ chức.',

    // ── Canary ───────────────────────────────────────────────────────────
    'aiFlows.canary.toggle': 'Thử luồng ứng viên trên một phần người xem',
    'aiFlows.canary.title': 'Ứng viên',
    'aiFlows.canary.pick': '— chọn luồng ứng viên —',
    'aiFlows.canary.hint':
      '{{percent}}% người xem nhận luồng ứng viên, số còn lại giữ luồng ở trên. Mỗi người xem giữ nguyên luồng đã nhận trong suốt cuộc hội thoại.',
    'aiFlows.canary.sameFlow': 'Ứng viên trùng với luồng hiện tại — không so sánh được gì.',
    'aiFlows.canary.arm': 'Nhánh',
    'aiFlows.canary.primary': 'Đang chạy',
    'aiFlows.canary.candidate': 'Ứng viên',
    'aiFlows.canary.runs': 'Lượt',
    'aiFlows.canary.usd': 'Chi phí/lượt',
    'aiFlows.canary.latency': 'Trung vị',
    'aiFlows.canary.verified': 'Kiểm chứng',
    'aiFlows.canary.errors': 'Lỗi',
    'aiFlows.canary.thinData':
      'Một nhánh có dưới 20 lượt — chưa đủ để kết luận. Các lượt chạy thử không được tính.',

    // ── Runs ─────────────────────────────────────────────────────────────
    'aiFlows.runs.title': 'Lượt chạy',
    'aiFlows.runs.subtitle':
      'Mỗi lượt người xem hỏi là một dòng. Mở ra để xem AI chạy những bước nào, gọi gì, và mọi con số có truy được về bằng chứng không.',
    'aiFlows.runs.empty': 'Chưa có lượt chạy nào được ghi.',
    'aiFlows.runs.refresh': 'Làm mới',
    'aiFlows.runs.colTime': 'Lúc',
    'aiFlows.runs.colQuestion': 'Câu hỏi',
    'aiFlows.runs.colFlow': 'Luồng',
    'aiFlows.runs.colVerification': 'Kiểm chứng',
    'aiFlows.runs.colCost': 'Chi phí',
    'aiFlows.runs.colLatency': 'Thời gian',
    'aiFlows.runs.modePreview': 'thử',
    'aiFlows.runs.detail': 'Chi tiết lượt chạy',
    'aiFlows.runs.stepsRan': 'Các bước đã chạy',
    'aiFlows.runs.evidence': 'Bằng chứng số liệu',
    'aiFlows.runs.evidenceHint': 'Mọi con số trong câu trả lời phải khớp một dòng ở đây',
    'aiFlows.runs.noEvidence': 'Lượt này không gọi công cụ nào.',

    // ── Model policies ───────────────────────────────────────────────────
    'aiFlows.policies.title': 'Cấu hình model',
    'aiFlows.policies.subtitle':
      'Mỗi mức model ánh xạ sang model nào, theo từng nhà cung cấp. Để ở đây nên khi nhà cung cấp khai tử một model thì chỉ cần đổi cấu hình, không cần deploy.',
    'aiFlows.policies.colPolicy': 'Mức',
    'aiFlows.policies.colProvider': 'Nhà cung cấp',
    'aiFlows.policies.colModel': 'Model',
    'aiFlows.policies.colTools': 'Gọi được công cụ',
    'aiFlows.policies.colEnabled': 'Bật',

    // ── Permissions / errors ─────────────────────────────────────────────
    'aiFlows.perm.readOnly': 'Bạn chỉ có quyền xem Xưởng AI.',
    'aiFlows.perm.needFull': 'Thao tác này cần quyền “full”.',
    'aiFlows.error.loadFlow': 'Không tải được luồng.',
    'aiFlows.error.conflict': 'Luồng này vừa được cập nhật ở tab khác hoặc bởi người khác.',
    'aiFlows.error.conflictReload': 'Tải lại bản mới nhất',
    'aiFlows.error.missingAgent': 'Chuyên gia không còn khả dụng',
    'aiFlows.error.replace': 'Thay thế',
    'aiFlows.mobile.unsupported':
      'Trình dựng luồng cần màn hình lớn để chỉnh sửa. Bạn vẫn xem được luồng, lượt chạy và duyệt.',
  },
};
