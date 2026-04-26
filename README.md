# Infinite Canvas — Specialized Module Workflows

---

## Prerequisites

Before using any specialized module, complete this one-time setup:

```bash
git clone <repository-url>
cd infinite-canvas
npm install
npm run dev
```

Place your Google Cloud service account file at the project root as `service-account.json` (required for all AI features).

**USAJobs integration only** — create `.env` in the project root:
```env
USAJOBS_API_KEY=your_usajobs_api_key
USAJOBS_EMAIL=your_usajobs_email
```

---

## Module 1 — Job Search Hub

Reads your resume, queries 12 job boards simultaneously, AI-scores every result for fit, and populates the canvas with ranked Job Cards you can track through the full application lifecycle.

**Covered sources:** Google Jobs · Indeed · LinkedIn · RemoteOK · WeWorkRemotely · ZipRecruiter · Glassdoor · Dice · Wellfound · Greenhouse · Lever · USAJobs

### Step-by-step workflow

**1. Place the hub on the canvas**
Open the left sidebar. Under the **Jobs** tab, drag the **Job Search** card onto an empty area of the canvas. A blue hub node appears with an animated source ring showing all 12 job board icons.

**2. Feed it your resume**
Drop any resume file directly onto the hub node. Accepted formats: PDF, DOCX, DOC, TXT, or an image (PNG/JPG scan). Alternatively, drop a resume file anywhere on the canvas — a hub is auto-created and starts immediately.

**3. Watch the four-phase pipeline**
The hub progresses automatically through four phases. The source ring updates live as each board is queried.

| Phase | What happens |
|---|---|
| Reading resume | AI extracts skills, titles, years of experience |
| Planning search | AI generates title-based, role-pivot, and skills-only query sets |
| Searching | All 12 boards searched in parallel; each source shows its live count |
| AI scoring | Every result scored for match %, assigned a strength label and career direction |

**4. Read your Job Cards**
When done, Job Cards fan out to the right of the hub, each connected by an animated edge. Each card shows:
- Match score (percentage badge, color-coded by strength label)
- **Strength label**: `Strong Match` · `Worth Exploring` · `Stretch` · `Unexpected Find`
- AI reasoning paragraph explaining the match
- Company, location, posted date, and salary if available
- Source board tag

**5. Filter by source**
On the hub's source ring, click any board icon (e.g. LinkedIn) to highlight only jobs from that source. Unselected cards dim to 20% opacity. Click the same icon again to show all.

**6. Open a listing**
On any Job Card, click the **↗** (external link) icon to open the original posting in your browser.

**7. Track application status**
Use the status dropdown at the bottom of each Job Card to move it through your pipeline:
`New` → `Applied` → `Interview` → `Offer` → `Rejected`

**8. Generate a cover letter**
Expand a Job Card (click the chevron), then click **Generate Cover Letter**. The AI writes a tailored letter using your resume profile and the job's title, company, and description. Copy it to clipboard directly from the card.

**9. Dismiss, save, and revisit**
- Click the **×** on a card to dismiss jobs that don't interest you.
- Press **⌘S** to save the workspace. All Job Cards, their statuses, cover letters, and the hub's state are persisted.
- Reload the workspace later to continue tracking — statuses are fully preserved.

**10. Start a new search**
To search again (e.g. after updating your resume), hover over the hub and click the small **×** reset icon. Drop a new resume file to restart.

---

## Module 2 — Marketplace Sell Hub

Identifies your product from photos, generates a marketplace listing, researches live sold comparables across 7 price sources, recommends a price tier, and opens the selected platforms ready to paste your listing.

**Price research sources:** eBay Sold · Poshmark Sold · Swappa · StockX · Reverb Sold · eBay Active · Mercari Sold  
**Posting platforms:** eBay · Facebook Marketplace · Mercari · Poshmark · Depop · Swappa · Reverb · Whatnot

### Step-by-step workflow

**1. Place the hub on the canvas**
Open the left sidebar. Under the **Sell** tab, drag the **Marketplace** card onto the canvas. An amber hub appears with the platform ring around it.

**2. Drop product photos**
Drop one or more product images (PNG, JPG, JPEG, WEBP, GIF) directly onto the hub. The hub auto-starts image analysis. Alternatively, drop images anywhere on the canvas.

**3. AI photo analysis**
The hub transitions to `Analyzing`. The Gemini Vision model reads the photos and generates:
- Brand, model, category, condition, color
- Generated listing title and description
- Notable features

**4. Review and edit the draft**
When analysis completes, the hub moves to `Draft` state. Every field is inline-editable — click any field to correct it before proceeding. Fields: title, brand, model, condition, description.

**5. Confirm and research price**
Click **Confirm & Research Price**. The hub enters `Researching` state. The source ring switches to comp source icons and shows live progress as each marketplace is scraped for sold comparables.

**6. Read the price recommendation**
When research completes (`Priced` state), the hub displays three price tiers:
- **Recommended** — fair market value based on comps
- **Quick Sell** — below market to move fast
- **Max Profit** — upper bound of the range

Expand the **Justification** section to read the AI's reasoning and a list of actual sold comparable listings.

**7. Set your price**
Click any of the three quick-price buttons to auto-fill, or type your own price into the **Your Price** field.

**8. Select platforms**
Toggle which platforms you want to list on using the platform selector buttons.

**9. Copy or save the listing**
- Click **Copy Listing** to copy the full formatted listing text to your clipboard.
- Click **Save to File** to open a native save dialog and write the listing as a `.txt` file to any location on disk.

**10. Open platforms**
Click any platform icon in the source ring (or click **List on Platforms**) to open that platform's listing creation page directly in your browser. The ring icon animates to `Opened ✓` to confirm which platforms you've visited.

**11. Mark as listed**
After posting on a platform, click the platform's **Mark as Listed** button in the priced state panel. It turns green with a checkmark (`✓ eBay`) and persists across reloads so you always know what's been posted.

**12. Save your workspace**
Press **⌘S** to save. The hub retains the product data, pricing, comp results, your price choice, and the per-platform listed status.

---

## Gap Analysis — Remaining Gaps

The following gaps remain after the current implementation. Items marked ✅ have been implemented.

### Job Search Hub

| Status | Gap | Impact |
|---|---|---|
| ✅ | **Notes field on Job Cards** | Inline textarea, debounced save, persists with workspace |
| ✅ | **Score threshold + status filter** | Slider + multi-toggle on hub done state, dims cards that don't match |
| ✅ | **Cover letter save to file** | Native OS save dialog, writes `.txt` |
| ✅ | **Re-run search** | "Re-run Search" button clears old connected cards and restarts the full pipeline |
| ✅ | **Export job cards as CSV** | "Export CSV" writes `Title,Company,Location,Score,Strength,Status,Source,URL,Notes` |
| ✅ | **Application date tracking** | `appliedAt` / `interviewAt` ISO timestamps recorded on status change; days-since badge shown next to status dropdown |
| ✅ | **Interview prep** | "Generate Interview Prep" button appears when status = `Interview`; AI generates 8 role-specific Q&As (3 behavioral / 3 technical / 2 company) with coaching tips; persists to node data |
| — | **Cards manually disconnected from hub are not cleaned up on re-run** | Edge case; normal workflow unaffected |

### Marketplace Sell Hub

| Status | Gap | Impact |
|---|---|---|
| ✅ | **Product photos now visible** — thumbnails in Draft and Priced states via `local-file://` | Real preview of item |
| ✅ | **Listing saved to file** — "Save to File" writes listing text via native dialog | No more clipboard-only risk |
| ✅ | **Per-platform mark-as-listed** — green checkmark per platform, persisted to node data; toggle removes the mark | Tracks what's been posted |
| ✅ | **Re-research prices** | "Refresh Prices" button re-runs the full comp scraping pipeline |
| ✅ | **Preview & edit listing text** | Expandable textarea under Copy/Save buttons shows full listing; user can customize text before copying or saving; focus-aware sync prevents overwrite mid-edit |
| ✅ | **Add photos without restarting** | Dropping images on draft/priced hub appends to `imagePaths` with deduplication; only empty/error state triggers fresh analysis |
| — | **No photo auto-upload to platforms** — photos exist locally, cannot be auto-attached | User must re-attach photos on each platform manually |


