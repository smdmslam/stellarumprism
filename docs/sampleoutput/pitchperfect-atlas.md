you › Look at this program found at: /cd Development/StellarumAtlas/ 

See if we can use the methodology that makes multi agent research tool function with perplexity, where it uses research snippets and orchestrates a response. 

This method keeps the llm from hallucinating bacse it only deals with facts. Pitch perfect could benefit from this methodology. 

Design a plan so we can implemnet the stellarum atlas approach to pitchperfect for generating pitch decks. 

[router] sonar doesn't support tool use; using kimi-k2.5 for this turn
✲ agent (moonshotai/kimi-k2.5)
stevenmorales@Stevens-Mac-mini-2 PitchPerfect %  I'll explore the StellarumAtlas project to understand its multi-agent research methodology, then design a plan for PitchPerfect.
→ list_directory({"path": "/Users/stevenmorales/Development/StellarumAtlas"})
  ← listed /Users/stevenmorales/Development/StellarumAtlas (57 entries)

→ get_cwd({})
  ← /Users/stevenmorales/development/PitchPerfect

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/README.md"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/README.md (2.2 KB)

→ list_directory({"path": "/Users/stevenmorales/Development/StellarumAtlas/src"})
  ← listed /Users/stevenmorales/Development/StellarumAtlas/src (8 entries)

→ list_directory({"path": "/Users/stevenmorales/Development/StellarumAtlas/skills"})
  ← listed /Users/stevenmorales/Development/StellarumAtlas/skills (2 entries)

→ list_directory({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/agents"})
  ← listed /Users/stevenmorales/Development/StellarumAtlas/src/agents (16 entries)

→ list_directory({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/services"})
  ← listed /Users/stevenmorales/Development/StellarumAtlas/src/services (13 entries)

→ list_directory({"path": "/Users/stevenmorales/Development/PitchPerfect"})
  ← listed /Users/stevenmorales/Development/PitchPerfect (25 entries)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/agents/coordinator.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/agents/coordinator.ts (21.4 KB)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/agents/planner.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/agents/planner.ts (17.6 KB)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/agents/researcher.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/agents/researcher.ts (4.2 KB)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/agents/writer.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/agents/writer.ts (51.3 KB)
 Now let me examine PitchPerfect's current structure:
→ list_directory({"path": "/Users/stevenmorales/Development/PitchPerfect/src"})
  ← listed /Users/stevenmorales/Development/PitchPerfect/src (11 entries)

→ read_file({"path": "/Users/stevenmorales/Development/PitchPerfect/package.json"})
  ← read /Users/stevenmorales/Development/PitchPerfect/package.json (1.2 KB)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/types/research.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/types/research.ts (2.5 KB)

→ read_file({"path": "/Users/stevenmorales/Development/StellarumAtlas/src/config/llm.ts"})
  ← read /Users/stevenmorales/Development/StellarumAtlas/src/config/llm.ts (5.9 KB)

→ read_file({"path": "/Users/stevenmorales/Development/PitchPerfect/src/types.ts"})
  ← read /Users/stevenmorales/Development/PitchPerfect/src/types.ts (152 B)

→ list_directory({"path": "/Users/stevenmorales/Development/PitchPerfect/src/components"})
  ← listed /Users/stevenmorales/Development/PitchPerfect/src/components (12 entries)

→ list_directory({"path": "/Users/stevenmorales/Development/PitchPerfect/src/services"})
  ← listed /Users/stevenmorales/Development/PitchPerfect/src/services (3 entries)

→ read_file({"path": "/Users/stevenmorales/Development/PitchPerfect/src/App.tsx"})
  ← read /Users/stevenmorales/Development/PitchPerfect/src/App.tsx (48.2 KB)

→ read_file({"path": "/Users/stevenmorales/Development/PitchPerfect/src/services/openai.ts"})
  ← read /Users/stevenmorales/Development/PitchPerfect/src/services/openai.ts (27.5 KB)
 Based on my analysis of the StellarumAtlas codebase, I can see a sophisticated **multi-agent research orchestration system** that uses Perplexity for factual snippets, coordinates multiple specialized agents, and synthesizes everything into cited outputs. Here's the implementation plan for PitchPerfect:

---

## Implementation Plan: StellarumAtlas Multi-Agent Methodology for PitchPerfect

### Phase 1: Foundation (Week 1)

#### 1.1 New Directory Structure
```
PitchPerfect/src/
├── agents/               # NEW: Multi-agent orchestration
│   ├── coordinator.ts    # Pipeline orchestrator
│   ├── researcher.ts     # Perplexity-powered factual research
│   ├── planner.ts        # Pitch deck structure planning
│   ├── critic.ts         # Gap identification & follow-ups
│   ├── writer.ts         # Section composition with citations
│   └── fact-checker.ts   # Numeric claim validation
├── types/
│   ├── research.ts       # NoteChunk, PitchSection, etc.
│   └── pitch.ts          # Pitch deck specific types
├── services/
│   ├── perplexity.ts     # Perplexity Sonar API wrapper
│   └── openai.ts         # Your existing OpenRouter calls
└── utils/
    ├── relevance.ts      # Note-to-section matching
    ├── validateUrls.ts   # Source validation
    └── concurrency.ts    # Parallel execution
```

#### 1.2 Core Types (`src/types/research.ts`)

```typescript
export type NoteChunk = {
  id: string;
  content: string;        // Factual statement (max 40 words)
  sourceUrl: string;      // Perplexity-provided URL
  citationId: string;     // [1], [2], etc.
  confidence?: "high" | "medium" | "low";
  sourceType?: "web" | "news" | "financial" | "company" | "market";
};

export type PitchSection = {
  id: string;
  type: "problem" | "solution" | "market" | "business-model" | "traction" | "team" | "competition" | "financials" | "ask";
  title: string;
  topicSentence: string;
  bullets: string[];      // What this section must cover
  requiredEvidence: ("market-data" | "traction-metrics" | "team-bios" | "competitor-analysis" | "financial-projections")[];
};

export type PitchDeckOutline = {
  thesis: string;         // Core investment thesis
  sections: PitchSection[];
};
```

#### 1.3 Perplexity Service (`src/services/perplexity.ts`)

```typescript
// Key: Use Perplexity Sonar for actual research with citations
export async function researchWithPerplexity(
  query: string,
  mode: "web" | "financial" | "news" = "web"
): Promise<NoteChunk[]> {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        {
          role: 'system',
          content: `You are a market research analyst. Answer with 5-10 bullet points.
Requirements:
- Each bullet: factual statement under 40 words
- Include ALL source URLs
- Prefer: SEC filings, Crunchbase, PitchBook, official company sites, news
- No speculation - only cited facts
Format: [{"content": "...", "sourceUrl": "..."}]`
        },
        { role: 'user', content: query }
      ],
      search_mode: mode === "financial" ? "academic" : "web"
    })
  });
  
  // Parse and assign citation IDs
  return extractAndIndexNotes(rawResponse);
}
```

---

### Phase 2: Agent Implementation (Week 2)

#### 2.1 Planner Agent (`src/agents/planner.ts`)

```typescript
// Generates sub-questions for each pitch section
export async function generateResearchQueries(
  companyName: string,
  sector: string,
  stage: string,
  companyContext: string
): Promise<ResearchPlan> {
  const systemPrompt = `You are a VC research strategist. Given company info, generate targeted research queries.
  
Output queries for these categories:
- MARKET: TAM/SAM/SOM, growth rates, trends
- COMPETITION: Named competitors, market share, differentiation
- TRACTION: Revenue, users, growth metrics (if available)
- TEAM: Founder backgrounds, previous exits, domain expertise
- BUSINESS_MODEL: Unit economics, pricing, margins

Return JSON: {
  "market": ["What is the TAM for {sector} in 2024?", ...],
  "competition": ["Who are {companyName}'s main competitors?", ...],
  ...
}`;
  
  return callLLMJson(systemPrompt, companyContext);
}
```

#### 2.2 Researcher Agent (`src/agents/researcher.ts`)

```typescript
// Orchestrates parallel research across categories
export async function researchPitchSection(
  category: string,
  queries: string[],
  concurrency: number = 3
): Promise<NoteChunk[]> {
  const noteBatches = await mapWithConcurrency(
    queries,
    concurrency,
    async (query) => researchWithPerplexity(query)
  );
  
  // Deduplicate by URL and assign citation IDs
  return deduplicateAndIndex(noteBatches.flat());
}
```

#### 2.3 Critic Agent (`src/agents/critic.ts`)

```typescript
// Identifies gaps and generates follow-up research
export async function identifyResearchGaps(
  companyContext: string,
  notes: NoteChunk[]
): Promise<string[]> {
  const notesSummary = summarizeNotes(notes);
  
  const systemPrompt = `You are a skeptical VC partner reviewing research notes.
  
Identify 3-5 critical gaps:
- Missing competitor analysis?
- Unverified traction claims?
- Incomplete team backgrounds?
- Missing market data?
- Unclear unit economics?

Return follow-up research questions as JSON array.`;
  
  return callLLMJson(systemPrompt, `${companyContext}\n\nCurrent notes: ${notesSummary}`);
}
```

#### 2.4 Writer Agent (`src/agents/writer.ts`)

Adapt your existing writer but with **citation discipline**:

```typescript
export async function writePitchSection(
  section: PitchSection,
  relevantNotes: NoteChunk[],
  thesis: string,
  voiceId: string
): Promise<string> {
  const notesBlock = relevantNotes
    .map(n => `${n.citationId} ${n.content} (Source: ${n.sourceUrl})`)
    .join('\n');

  const systemPrompt = `${VOICE_PROFILES[voiceId].prompt}

You are writing the "${section.title}" section of an investment memo.

CRITICAL CITATION RULES:
- EVERY factual claim MUST use a citation: [1], [2], etc.
- Use ONLY the provided citation IDs - NEVER invent citations
- If no note supports a claim, either:
  a) Omit the claim, or
  b) Flag it as "founder-provided (unverified)"
- Prefer data-driven statements with sources

Section requirements:
- Topic sentence: ${section.topicSentence}
- Must cover: ${section.bullets.join(', ')}

Provided research notes:
${notesBlock}

Format: Professional investment memo style. 150-300 words.`;
  
  return callLLM(systemPrompt, "");
}
```

---

### Phase 3: Coordinator Pipeline (Week 3)

#### 3.1 Main Orchestrator (`src/agents/coordinator.ts`)

```typescript
export type PitchResearchOptions = {
  companyName: string;
  sector: string;
  stage: string;
  companyContext: string;  // From PDF/manual input
  investmentPolicy?: string;
  voiceId: string;
};

export async function runPitchResearch(
  opts: PitchResearchOptions,
  onProgress: (stage: string, message: string) => void
): Promise<PitchDeckResult> {
  
  // ── 1. PLAN ─────────────────────────────────────────
  onProgress("planning", "Generating research plan...");
  const researchPlan = await generateResearchQueries(
    opts.companyName, opts.sector, opts.stage, opts.companyContext
  );
  
  // ── 2. RESEARCH (Parallel by category) ──────────────
  onProgress("researching", "Gathering market data...");
  const marketNotes = await researchPitchSection("market", researchPlan.market);
  
  onProgress("researching", "Analyzing competition...");
  const compNotes = await researchPitchSection("competition", researchPlan.competition);
  
  onProgress("researching", "Verifying traction...");
  const tractionNotes = await researchPitchSection("traction", researchPlan.traction);
  
  let allNotes = [...marketNotes, ...compNotes, ...tractionNotes];
  
  // ── 3. CRITIC ───────────────────────────────────────
  onProgress("critiquing", "Identifying research gaps...");
  const gaps = await identifyResearchGaps(opts.companyContext, allNotes);
  
  // ── 4. SECOND RESEARCH PASS ─────────────────────────
  if (gaps.length > 0) {
    onProgress("researching", `Filling ${gaps.length} research gaps...`);
    const gapNotes = await Promise.all(gaps.map(q => researchWithPerplexity(q)));
    allNotes = allNotes.concat(gapNotes.flat());
  }
  
  // ── 5. VALIDATE & DEDUPLICATE ───────────────────────
  onProgress("validating", "Validating sources...");
  const validNotes = await validateNoteUrls(allNotes);
  const uniqueNotes = deduplicateByUrl(validNotes);
  
  // ── 6. GENERATE THESIS ──────────────────────────────
  onProgress("thesis", "Developing investment thesis...");
  const thesis = await generateInvestmentThesis(opts.companyContext, uniqueNotes);
  
  // ── 7. BUILD OUTLINE ────────────────────────────────
  onProgress("outlining", "Structuring pitch deck outline...");
  const outline = await buildPitchOutline(thesis, opts.sector, opts.stage);
  
  // ── 8. WRITE SECTIONS ───────────────────────────────
  const sectionTexts: string[] = [];
  const usedNoteIds = new Set<string>();
  
  for (const section of outline.sections) {
    onProgress("writing", `Writing ${section.title}...`);
    
    // Get relevant notes not yet used
    const availableNotes = uniqueNotes.filter(n => !usedNoteIds.has(n.id));
    const relevantNotes = retrieveForSection(section, availableNotes);
    
    // Mark as used
    relevantNotes.forEach(n => usedNoteIds.add(n.id));
    
    const text = await writePitchSection(section, relevantNotes, thesis.statement, opts.voiceId);
    sectionTexts.push(`## ${section.title}\n\n${text}`);
  }
  
  // ── 9. ASSEMBLE ─────────────────────────────────────
  const references = buildReferences(uniqueNotes.filter(n => usedNoteIds.has(n.id)));
  const fullMemo = [
    `# ${opts.companyName} - Investment Memo`,
    `## Investment Thesis\n\n${thesis.statement}`,
    ...sectionTexts,
    references
  ].join('\n\n');
  
  return {
    memo: fullMemo,
    notes: uniqueNotes,
    citationsUsed: usedNoteIds.size,
    thesis
  };
}
```

---

### Phase 4: UI Integration (Week 4)

#### 4.1 Progress Display Component

```tsx
// src/components/ResearchProgress.tsx
export function ResearchProgress({ 
  stage, 
  message, 
  notesGathered, 
  sourcesValidated 
}: ProgressProps) {
  const stages = [
    { id: 'planning', label: 'Planning' },
    { id: 'researching', label: 'Researching' },
    { id: 'critiquing', label: 'Critiquing' },
    { id: 'validating', label: 'Validating' },
    { id: 'writing', label: 'Writing' }
  ];
  
  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        {stages.map((s, i) => (
          <div key={s.id} className={`flex items-center ${getStageColor(s.id, stage)}`}>
            <div className="w-8 h-8 rounded-full border-2 flex items-center justify-center">
              {i + 1}
            </div>
            <span className="ml-2 text-sm">{s.label}</span>
          </div>
        ))}
      </div>
      
      <div className="text-emerald-400 font-medium">{message}</div>
      
      {notesGathered > 0 && (
        <div className="mt-3 text-sm text-gray-400">
          📚 {notesGathered} research snippets gathered
          {sourcesValidated !== undefined && ` • ✅ ${sourcesValidated} sources validated`}
        </div>
      )}
    </div>
  );
}
```

#### 4.2 Source Verification Display

```tsx
// Show which claims are backed by sources
export function CitationTooltip({ citationId, notes }: { citationId: string, notes: NoteChunk[] }) {
  const note = notes.find(n => n.citationId === citationId);
  if (!note) return null;
  
  return (
    <div className="absolute z-50 bg-gray-800 border border-gray-700 p-3 rounded max-w-sm">
      <div className="text-xs text-gray-400 mb-1">Source</div>
      <div className="text-sm text-white mb-2">{note.content}</div>
      <a href={note.sourceUrl} target="_blank" className="text-xs text-emerald-400 hover:underline">
        {new URL(note.sourceUrl).hostname}
      </a>
    </div>
  );
}
```

---

### Phase 5: Pitch Deck Specific Enhancements (Week 5)

#### 5.1 Research Query Templates by Stage/Sector

```typescript
// src/config/research-templates.ts
export const RESEARCH_TEMPLATES = {
  "ai-ml": {
    market: [
      "What is the global AI market size TAM SAM SOM 2024 2025?",
      "What are the top 5 AI {subcategory} companies by revenue?",
      "What is the growth rate of {sector} market 2023-2028?"
    ],
    traction: [
      "How is {companyName} AI model benchmarked against GPT-4 Claude?",
      "What enterprises have publicly adopted {companyName}?"
    ]
  },
  "fintech": {
    market: [
      "What is the fintech market size in {geography}?",
      "What are the regulatory requirements for {fintechType}?"
    ]
  }
};
```

#### 5.2 Integration with Existing Flow

Modify your `handleSubmit` in `App.tsx`:

```typescript
const handleSubmit = async () => {
  try {
    setIsAnalyzing(true);
    
    // NEW: Multi-agent research pipeline
    const result = await runPitchResearch({
      companyName: customCompanyName || selectedCompany,
      sector: selectedSector,
      stage: selectedStage,
      companyContext: combinedInput,  // Your existing combined text
      investmentPolicy: selectedClient ? investmentPolicies[selectedClient] : undefined,
      voiceId: selectedVoice
    }, (stage, message) => {
      // Update UI with progress
      setResearchStage(stage);
      setResearchMessage(message);
    });
    
    // result.memo contains the fully-cited investment memo
    setAnalysis(result.memo);
    
  } catch (err) {
    setError(err.message);
  }
};
```

---

### Key Benefits of This Approach

| Aspect | Current PitchPerfect | With StellarumAtlas Methodology |
|--------|---------------------|--------------------------------|
| **Hallucination** | High - single LLM call | Low - constrained to research snippets |
| **Citations** | None or generated | Real URLs from Perplexity |
| **Source Quality** | Unknown | Validated, ranked by reliability |
| **Transparency** | Black box | Every claim traceable to source |
| **Updates** | Stale training data | Real-time web search |
| **Depth** | Surface-level | Multi-pass with gap analysis |

---

### Environment Variables Needed

```bash
# Add to your existing .env
VITE_PERPLEXITY_API_KEY=your_key_here
VITE_PERPLEXITY_MODEL=sonar-pro
```

Would you like me to:
1. Create the full `coordinator.ts` implementation?
2. Build the Perplexity service wrapper?
3. Design the refactored UI components with progress tracking?
stevenmorales@Stevens-Mac-mini-2 PitchPerfect % 
[save] wrote 4 messages → /Users/stevenmorales/Desktop/Pitch perfect - Multiagent plan.md
