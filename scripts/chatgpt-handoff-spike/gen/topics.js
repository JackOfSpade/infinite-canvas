// Content library for the synthetic fixture generator: employer domains and
// achievement "topics". Everything here is invented. A topic ties three things
// together so the fixtures stay coherent:
//   - `req` / `resp`: how a job listing states a requirement / responsibility,
//   - `label`: the short own-words phrase an evidence item uses to name the
//     listing requirement a career quote proves,
//   - `templates`: ways a career document (résumé bullet, achievements log)
//     states the same accomplishment, each returning a full corpus `text` (150
//     to 250 characters) and a shorter résumé-ready `short` that reuses the same
//     verbs and figures, so the résumé bullet stays source-grounded.
//
// A template is (x) => ({ text, short }) where x = { r, d, money }:
//   r      seeded rng (see synthetic.js), d the employer domain, money(lo, hi)
//   a formatter for an amount in thousands ("$410k", "€1.2M", "£640k") whose
//   currency rotates through the domain's own currencies.
//
// Wording rules the templates follow because the app's own validators read the
// generated documents: no em or en dash and no semicolon in `short` (candidate
// copy), no "N years" spans, and a verb such as "cut", "reduced" or "led" in
// `short` only when `text` states it too.

export const DOMAINS = {
  payments: {
    sys: ['payment-authorization service', 'ledger service', 'fraud-scoring pipeline', 'settlement engine', 'merchant-onboarding API', 'refund workflow'],
    grp: ['payment services', 'ledger and settlement services', 'merchant-facing services', 'card-processing services'],
    unit: ['transactions', 'settlement records', 'merchant accounts', 'payout instructions'],
    op: ['authorization', 'settlement', 'refund', 'payout'],
    peak: ['holiday peak', 'month-end close', 'quarter-end payout run'],
    product: ['instant payouts', 'multi-currency settlement', 'a merchant risk dashboard', 'recurring billing'],
    audit: 'PCI DSS',
    currencies: ['€', '£', '$'],
  },
  health: {
    sys: ['patient-records integration layer', 'HL7 interface engine', 'claims-processing pipeline', 'appointment-scheduling API', 'lab-results feed', 'clinical data warehouse'],
    grp: ['clinical integration services', 'claims and eligibility services', 'patient-facing services', 'interface-engine channels'],
    unit: ['patient records', 'claims', 'lab results', 'appointment requests'],
    op: ['eligibility check', 'claim submission', 'record lookup', 'results delivery'],
    peak: ['open-enrollment peak', 'flu-season surge', 'month-end billing run'],
    product: ['a patient-portal integration', 'real-time eligibility checks', 'a lab-results alerting feed', 'a clinician scheduling view'],
    audit: 'HIPAA',
    currencies: ['$'],
  },
  analytics: {
    sys: ['dashboard query layer', 'ingestion pipeline', 'metrics store', 'report-scheduling service', 'semantic-layer service', 'data export API'],
    grp: ['ingestion services', 'reporting services', 'warehouse jobs', 'customer-facing analytics services'],
    unit: ['usage events', 'report snapshots', 'customer extracts', 'audit records'],
    op: ['dashboard query', 'report export', 'data refresh', 'ingestion run'],
    peak: ['quarter-end reporting peak', 'Monday-morning peak', 'budget-season peak'],
    product: ['self-serve dashboards', 'scheduled report delivery', 'a metrics API', 'embedded analytics'],
    audit: 'SOC 2 Type II',
    currencies: ['$'],
  },
  freight: {
    sys: ['shipment-tracking API', 'carrier-integration layer', 'rate-quoting service', 'dock-scheduling service', 'load-planning engine', 'proof-of-delivery pipeline'],
    grp: ['tracking services', 'carrier-facing services', 'dispatch services', 'warehouse-integration services'],
    unit: ['shipments', 'carrier messages', 'rate quotes', 'delivery events'],
    op: ['rate quote', 'tracking lookup', 'tender', 'dispatch'],
    peak: ['holiday shipping peak', 'quarter-end peak', 'harvest-season surge'],
    product: ['live shipment tracking', 'automated carrier tendering', 'a customs-documents workflow', 'a customer delivery portal'],
    audit: 'ISO 27001',
    currencies: ['£', '€', '$'],
  },
  logistics: {
    sys: ['route-planning service', 'dispatch engine', 'driver-app backend', 'fleet-telemetry pipeline', 'delivery-window scheduler', 'warehouse-routing service'],
    grp: ['dispatch services', 'routing services', 'driver-facing services', 'fleet-integration services'],
    unit: ['routes', 'delivery stops', 'driver events', 'vehicle telemetry messages'],
    op: ['route optimization', 'dispatch', 'stop reassignment', 'ETA calculation'],
    peak: ['holiday delivery peak', 'Monday dispatch peak', 'end-of-month surge'],
    product: ['same-day routing', 'a driver mobile app', 'live ETA notifications', 'a route-adherence dashboard'],
    audit: 'SOC 2 Type II',
    currencies: ['$'],
  },
  robotics: {
    sys: ['fleet-orchestration service', 'task-scheduling engine', 'robot telemetry pipeline', 'warehouse-map service', 'charging-dock scheduler', 'firmware update channel'],
    grp: ['fleet services', 'robot-control services', 'telemetry services', 'warehouse-integration services'],
    unit: ['telemetry events', 'pick tasks', 'map updates', 'battery readings'],
    op: ['task assignment', 'map sync', 'telemetry ingest', 'firmware rollout'],
    peak: ['peak-season pick surge', 'shift-change surge', 'holiday fulfilment peak'],
    product: ['a robot-health dashboard', 'over-the-air firmware updates', 'a pick-path planner', 'a charging-schedule optimizer'],
    audit: 'ISO 27001',
    currencies: ['$'],
  },
}

// Employers in career order, most recent first. `domain` keys DOMAINS.
export const EMPLOYERS = [
  { key: 'pinecrest', name: 'Pinecrest Payments', domain: 'payments', title: 'Staff Platform Engineer', city: 'Toronto, ON', start: '2023-02', end: 'present' },
  { key: 'cobalt', name: 'Cobalt Health Systems', domain: 'health', title: 'Senior Data Engineer', city: 'Chicago, IL', start: '2020-06', end: '2023-01' },
  { key: 'harbor', name: 'Harbor Analytics', domain: 'analytics', title: 'Senior Software Engineer', city: 'Boston, MA', start: '2018-03', end: '2020-05' },
  { key: 'lumen', name: 'Lumen Freight', domain: 'freight', title: 'Software Engineer II', city: 'Waterloo, ON', start: '2016-05', end: '2018-02' },
  { key: 'brightline', name: 'Brightline Logistics', domain: 'logistics', title: 'Software Engineer', city: 'Denver, CO', start: '2014-08', end: '2016-04' },
  { key: 'northwind', name: 'Northwind Robotics', domain: 'robotics', title: 'Associate Software Engineer', city: 'Austin, TX', start: '2012-09', end: '2014-07' },
]

const pick = (r, list) => r.pick(list)
// "a 78%" but "an 85%": the article follows how the number is spoken.
const article = (n) => (/^8/.test(String(n)) || n === 11 || n === 18 ? 'an' : 'a')

// Vendor and initiative words shared by several templates.
const VENDORS = ['observability', 'incident-management', 'log-storage', 'CI hosting', 'feature-flag', 'secrets-management']
const INITIATIVES = ['platform consolidation', 'cloud cost', 'reliability', 'developer productivity', 'data-quality', 'compliance readiness']
const TEAMS = ['product', 'security', 'operations', 'data', 'finance', 'support']

/**
 * The topic library. Order matters: `CORE_TOPIC_IDS` below lists the ids every
 * listing carries; the rest are drawn by the seeded rng.
 */
export const TOPICS = [
  {
    id: 'k8s',
    tag: 'Kubernetes migration',
    label: 'Migrating services to Kubernetes and running them in production',
    req: ['Experience migrating services to Kubernetes and running them in production.'],
    resp: ['Lead the migration of our remaining legacy services onto the Kubernetes platform.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(9, 42), a = r.int(28, 55), b = r.int(4, 9); const grp = pick(r, d.grp)
        return {
          text: `Led the migration of ${n} ${grp} from hand-managed virtual machines to Kubernetes, cutting median deploy time from ${a} to ${b} minutes and ending the weekend-only release window.`,
          short: `Led the migration of ${n} ${grp} to Kubernetes, cutting median deploy time from ${a} to ${b} minutes.`,
          facts: { proof: `migrated the ${grp} to Kubernetes, and median deploy time fell from ${a} to ${b} minutes` },
        }
      },
      ({ r, d }) => {
        const m = r.int(3, 9), a = r.int(35, 70), b = r.int(5, 12); const sys = pick(r, d.sys)
        return {
          text: `Moved the ${sys} and ${m} supporting services onto Kubernetes with blue-green rollouts, so releases dropped from ${a} minutes to ${b} and the team shipped several times a week instead of once.`,
          short: `Moved the ${sys} and ${m} supporting services onto Kubernetes with blue-green rollouts, dropping releases from ${a} to ${b} minutes.`,
          facts: { proof: `migrated the ${sys} onto Kubernetes with blue-green rollouts, and release time fell from ${a} to ${b} minutes` },
        }
      },
      ({ r, d }) => {
        const n = r.int(2, 5), a = r.int(9, 22), b = r.int(1, 4); const sys = pick(r, d.sys)
        return {
          text: `Planned and ran a six-month move of the ${sys} to Kubernetes across ${n} clusters, holding error rates flat and cutting on-call pages for failed deploys from ${a} to ${b} a month.`,
          short: `Planned and ran the move of the ${sys} to Kubernetes across ${n} clusters, cutting on-call pages for failed deploys from ${a} to ${b} a month.`,
          facts: { proof: `migrated the ${sys} to Kubernetes, and on-call pages for failed deploys fell from ${a} to ${b} a month` },
        }
      },
    ],
  },
  {
    id: 'latency',
    tag: 'latency bottleneck removal',
    label: 'Finding and removing latency bottlenecks in high-traffic services',
    req: ['A record of finding and removing latency bottlenecks in high-traffic services.'],
    resp: ['Own latency budgets for the customer-facing request path and remove the bottlenecks that break them.'],
    templates: [
      ({ r, d }) => {
        const a = r.int(420, 900), b = r.int(140, 330), p = r.int(25, 60); const sys = pick(r, d.sys)
        return {
          text: `Cut p99 latency on the ${sys} from ${a} ms to ${b} ms by adding read-through caching and batching database calls, which took ${p}% of the load off the primary database.`,
          short: `Cut p99 latency on the ${sys} from ${a} ms to ${b} ms with read-through caching and batched database calls.`,
        }
      },
      ({ r, d }) => {
        const a = r.int(60, 240), b = r.int(150, 380); const op = pick(r, d.op)
        return {
          text: `Profiled the ${op} path end to end and removed a serialization step that added ${a} ms to every call, bringing p95 ${op} latency down to ${b} ms for the whole customer base.`,
          short: `Profiled the ${op} path and removed a serialization step that added ${a} ms to every call, bringing p95 latency down to ${b} ms.`,
        }
      },
      ({ r, d }) => {
        const a = r.int(700, 1800), b = r.int(180, 420); const sys = pick(r, d.sys); const peak = pick(r, d.peak)
        return {
          text: `Rewrote the hottest queries behind the ${sys} and added a covering-index strategy, dropping average response time from ${a} ms to ${b} ms through the ${peak}.`,
          short: `Rewrote the hottest queries behind the ${sys} and added a covering-index strategy, dropping average response time from ${a} ms to ${b} ms.`,
        }
      },
    ],
  },
  {
    id: 'cost',
    tag: 'cloud cost ownership',
    label: 'Owning cloud cost: forecasting, right-sizing and holding teams to budgets',
    req: ['Ownership of cloud cost, including forecasting, right-sizing and holding teams to their budgets.'],
    resp: ['Set cloud cost targets with finance and give every team the tooling to hold to them.'],
    templates: [
      ({ r, d, money }) => {
        const p = r.int(14, 34); const sys = pick(r, d.sys); const m = money(180, 900); const peak = pick(r, d.peak)
        return {
          text: `Reduced cloud spend by ${p}% (${m} a year) through right-sizing, spot-instance scheduling and retiring idle environments around the ${sys}, while keeping the ${peak} capacity plan intact.`,
          short: `Reduced cloud spend by ${p}% (${m} a year) through right-sizing, spot-instance scheduling and retiring idle environments.`,
        }
      },
      ({ r, money }) => {
        const p = r.int(9, 26); const m = money(240, 1900); const team = pick(r, TEAMS)
        return {
          text: `Built per-team cost dashboards with finance and negotiated committed-use discounts, cutting the annual compute bill by ${m}, about ${p}%, without slowing any ${team} team’s roadmap.`,
          short: `Built per-team cost dashboards with finance and negotiated committed-use discounts, cutting the annual compute bill by ${m}, about ${p}%.`,
        }
      },
      ({ r, d, money }) => {
        const n = r.int(30, 140); const m = money(90, 640); const grp = pick(r, d.grp)
        return {
          text: `Tagged and tracked spend for ${n} ${grp} and moved batch workloads to off-peak capacity, which saved ${m} a year and gave every owner a monthly cost report.`,
          short: `Tagged and tracked spend for ${n} ${grp} and moved batch workloads to off-peak capacity, which saved ${m} a year.`,
        }
      },
    ],
  },
  {
    id: 'reliability',
    tag: 'service-level objectives and error budgets',
    label: 'Defining service-level objectives and running error budgets',
    req: ['Experience defining service-level objectives and running error budgets with product teams.'],
    resp: ['Define and review service-level objectives with product teams and act on the error budget.'],
    templates: [
      ({ r, d }) => {
        const a = r.pick(['99.5', '99.6', '99.7', '99.8']), b = r.pick(['99.95', '99.97', '99.98', '99.99']), n = r.int(3, 9); const sys = pick(r, d.sys)
        return {
          text: `Raised ${sys} availability from ${a}% to ${b}% by adding automatic failover, load shedding and per-tenant rate limits, which ended ${n} recurring outage patterns.`,
          short: `Raised ${sys} availability from ${a}% to ${b}% by adding automatic failover, load shedding and per-tenant rate limits.`,
          facts: { proof: `implemented failover, load shedding and per-tenant rate limits for the ${sys}, and its availability reached ${b}%` },
        }
      },
      ({ r }) => {
        const n = r.int(6, 24), a = r.int(11, 30), b = r.int(2, 8)
        return {
          text: `Defined service-level objectives for ${n} services and wired error-budget alerts into release approvals, reducing customer-facing incidents from ${a} to ${b} a quarter.`,
          short: `Defined service-level objectives for ${n} services and wired error-budget alerts into release approvals, reducing customer-facing incidents from ${a} to ${b} a quarter.`,
          facts: { proof: `implemented service-level objectives and error-budget alerts across the services, and customer-facing incidents fell to ${b} a quarter` },
        }
      },
      ({ r, d }) => {
        const a = r.int(38, 95), b = r.int(6, 20); const grp = pick(r, d.grp)
        return {
          text: `Introduced graceful degradation for the ${grp}, so a failing dependency now sheds optional features first, and cut the median incident from ${a} to ${b} minutes of customer impact.`,
          short: `Introduced graceful degradation for the ${grp} and cut the median incident from ${a} to ${b} minutes of customer impact.`,
          facts: { proof: `implemented graceful degradation for the ${grp}, and the median incident dropped to ${b} minutes of customer impact` },
        }
      },
    ],
  },
  {
    id: 'oncall',
    tag: 'on-call ownership',
    label: 'Owning an on-call rotation and improving it',
    req: ['Comfort owning an on-call rotation and improving it over time.'],
    resp: ['Run and continually improve the platform on-call rotation and its runbooks.'],
    templates: [
      ({ r }) => {
        const n = r.int(3, 7), a = r.int(14, 38), b = r.int(3, 9)
        return {
          text: `Redesigned the on-call rotation and runbook system for ${n} teams, cutting overnight pages from ${a} to ${b} a week and shortening the median time to resolve for the engineers who carried the pager.`,
          short: `Redesigned the on-call rotation and runbook system for ${n} teams, cutting overnight pages from ${a} to ${b} a week.`,
        }
      },
      ({ r }) => {
        const a = r.int(20, 55), b = r.int(3, 10)
        return {
          text: `Wrote a runbook for every recurring page type from real incident timelines and added automated first-response steps, so the median page went from ${a} minutes of manual triage to ${b} and on-call engineers stopped escalating routine pages.`,
          short: `Wrote runbooks from real incident timelines and added automated first-response steps, cutting median triage from ${a} to ${b} minutes.`,
        }
      },
    ],
  },
  {
    id: 'observability',
    tag: 'tracing, metrics and alerting',
    label: 'Distributed tracing and metrics',
    req: ['Hands-on experience with distributed tracing, metrics and alerting.'],
    resp: ['Build the tracing, metrics and alerting that let teams see how a request behaves across services.'],
    templates: [
      ({ r, d }) => {
        const ms = r.int(220, 780), n = r.int(4, 12); const sys = pick(r, d.sys)
        return {
          text: `Rolled out OpenTelemetry tracing across the ${sys} path, exposing a ${ms} ms serialization bottleneck and giving ${n} teams a shared view of request latency.`,
          short: `Rolled out OpenTelemetry tracing across the ${sys} path, exposing a ${ms} ms serialization bottleneck for ${n} teams.`,
        }
      },
      ({ r }) => {
        const n = r.int(18, 60), p = r.int(35, 70)
        return {
          text: `Consolidated ${n} overlapping dashboards into one service-health view and tuned the alert thresholds, cutting noisy pages ${p}% in the first quarter and restoring trust in the pager.`,
          short: `Consolidated ${n} overlapping dashboards into one service-health view and tuned alert thresholds, cutting noisy pages ${p}% in the first quarter.`,
        }
      },
    ],
  },
  {
    id: 'iac',
    tag: 'infrastructure as code',
    label: 'Infrastructure as code at scale',
    req: ['Infrastructure as code (Terraform or similar) at scale.'],
    resp: ['Keep all production infrastructure defined as code, reviewed and reproducible.'],
    templates: [
      ({ r }) => {
        const p = r.int(78, 97), n = r.int(3, 11)
        return {
          text: `Drove infrastructure-as-code adoption: ${p}% of resources across ${n} cloud accounts are now managed in Terraform, and a nightly drift report opens a ticket for anything changed by hand.`,
          short: `Drove infrastructure-as-code adoption: ${p}% of resources across ${n} cloud accounts are now managed in Terraform.`,
        }
      },
      ({ r }) => {
        const a = r.int(5, 12), b = r.int(1, 3)
        return {
          text: `Replaced the hand-built environments with reviewed Terraform modules, so standing up a new region went from ${a} days of tickets to about ${b} ${b === 1 ? 'day' : 'days'} and every change left an audit trail.`,
          short: `Replaced the hand-built environments with reviewed Terraform modules, so a new region went from ${a} days to about ${b} ${b === 1 ? 'day' : 'days'}.`,
        }
      },
    ],
  },
  {
    id: 'cicd',
    tag: 'CI/CD and developer tooling',
    label: 'Building the CI/CD and developer tooling engineers actually use',
    req: ['Building the CI/CD pipelines and developer tooling that engineers actually use.'],
    resp: ['Improve the CI/CD pipelines and self-service tooling our engineers use every day.'],
    templates: [
      ({ r }) => {
        const a = r.int(6, 14), b = r.int(1, 2), c = r.int(24, 41), e = r.int(7, 14)
        return {
          text: `Owned the CI system for the whole engineering organization and cut the flaky-test rate from ${a}% to under ${b}%, taking the median pipeline from ${c} to ${e} minutes, which ended the daily ritual of re-running builds before every merge.`,
          short: `Owned the CI system for the engineering organization and cut the flaky-test rate from ${a}% to under ${b}%, taking the median pipeline from ${c} to ${e} minutes.`,
        }
      },
      ({ r }) => {
        const a = r.int(2, 6), b = r.int(3, 9)
        return {
          text: `Built a self-service staging-environment provisioner: one command, about ${b} minutes, replacing a ${a}-day ticket queue that every product team had used for years of sprints.`,
          short: `Built a self-service staging-environment provisioner: one command, about ${b} minutes, replacing a ${a}-day ticket queue.`,
        }
      },
      ({ r }) => {
        const a = r.int(9, 21), b = r.int(2, 5), n = r.int(30, 90)
        return {
          text: `Introduced trunk-based development with feature flags for ${n} engineers, which took the average time from merge to production from ${a} days to ${b} and made rollbacks a one-click action.`,
          short: `Introduced trunk-based development with feature flags for ${n} engineers, taking the average time from merge to production from ${a} days to ${b}.`,
        }
      },
    ],
  },
  {
    id: 'streaming',
    tag: 'event streaming and data pipelines',
    label: 'Event streaming and high-volume data pipelines',
    req: ['Experience with event streaming and high-volume data pipelines.'],
    resp: ['Design and operate the event-streaming backbone that carries our highest-volume data.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(2, 9), days = r.int(7, 30); const sys = pick(r, d.sys)
        return {
          text: `Built the event pipeline behind the ${sys}, sustaining ${n} million events per minute with at-least-once delivery and replay from any point in the last ${days} days.`,
          short: `Built the event pipeline behind the ${sys}, sustaining ${n} million events per minute with at-least-once delivery and replay.`,
        }
      },
      ({ r, d }) => {
        const a = r.int(4, 11), b = r.int(20, 90); const unit = pick(r, d.unit)
        return {
          text: `Replaced a nightly batch load of ${unit} with a Kafka-based stream, so downstream reports went from ${a} hours stale to under ${b} seconds and the batch window disappeared.`,
          short: `Replaced a nightly batch load of ${unit} with a Kafka-based stream, so downstream reports went from ${a} hours stale to under ${b} seconds.`,
        }
      },
    ],
  },
  {
    id: 'dataquality',
    tag: 'data quality and schema evolution',
    label: 'Data quality and schema evolution',
    req: ['Practical approaches to data quality and schema evolution.'],
    resp: ['Set the standards for data quality and schema changes across our pipelines.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(8, 24), a = r.int(30, 90), b = r.int(2, 9); const unit = pick(r, d.unit)
        return {
          text: `Introduced contract tests between ${n} services and schema checks on every ${unit} feed, reducing downstream data defects from ${a} to ${b} a month, and every failure now names the owning team.`,
          short: `Introduced contract tests between ${n} services and schema checks on every ${unit} feed, reducing downstream data defects from ${a} to ${b} a month.`,
        }
      },
      ({ r }) => {
        const a = r.int(52, 78), b = r.int(88, 97), n = r.int(30, 100)
        return {
          text: `Set up a schema registry with compatibility rules for ${n} topics, so a breaking change now fails in review rather than in production, and lifted first-pass data accuracy from ${a}% to ${b}%.`,
          short: `Set up a schema registry with compatibility rules for ${n} topics, so a breaking change fails in review rather than in production.`,
        }
      },
    ],
  },
  {
    id: 'security',
    tag: 'compliance and audit readiness',
    label: 'Working knowledge of compliance programs and security audits',
    req: ['Working knowledge of a compliance program such as PCI DSS or SOC 2.'],
    resp: ['Partner with security to keep the platform audit-ready and close findings quickly.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(12, 52); const sys = pick(r, d.sys)
        return {
          text: `Led ${d.audit} audit preparation for the ${sys}: closed ${n} high-severity findings in one quarter and passed the audit with no exceptions, the first clean result the program had recorded.`,
          short: `Led ${d.audit} audit preparation for the ${sys}: closed ${n} high-severity findings in one quarter and passed with no exceptions.`,
        }
      },
      ({ r }) => {
        const n = r.int(9, 30), h = r.int(140, 420)
        return {
          text: `Automated quarterly access reviews across ${n} systems, saving the security team about ${h} hours a year and closing the evidence gaps an auditor had flagged the year before.`,
          short: `Automated quarterly access reviews across ${n} systems, saving the security team about ${h} hours a year.`,
        }
      },
    ],
  },
  {
    id: 'mentoring',
    tag: 'mentoring senior talent',
    label: 'Mentoring engineers and growing senior technical talent',
    req: ['A record of mentoring engineers and growing senior technical talent.'],
    resp: ['Mentor engineers across the platform group and raise the technical bar.'],
    templates: [
      ({ r }) => {
        const n = r.int(4, 9), m = r.int(2, 4)
        return {
          text: `Mentored ${n} engineers through design reviews, pairing and stretch projects; ${m} were promoted, and one of them now leads a team of their own.`,
          short: `Mentored ${n} engineers through design reviews and pairing, ${m} of whom were promoted.`,
        }
      },
      ({ r }) => {
        const n = r.int(8, 16), t = r.int(9, 18)
        return {
          text: `Ran a weekly design-review clinic for ${n} engineers and paired with each new senior hire through their first project, which shortened onboarding to first production change to ${t} days.`,
          short: `Ran a weekly design-review clinic for ${n} engineers and paired with each new senior hire, shortening onboarding to first production change to ${t} days.`,
        }
      },
    ],
  },
  {
    id: 'hiring',
    tag: 'hiring and team building',
    label: 'Hiring and building a strong engineering bench',
    req: ['Involvement in hiring and building a strong engineering bench.'],
    resp: ['Help hire and onboard the next engineers on the platform team.'],
    templates: [
      ({ r }) => {
        const n = r.int(6, 12), p = r.int(78, 92)
        return {
          text: `Ran hiring for the platform team: ${n} hires in a year with ${article(p)} ${p}% offer-accept rate, using a structured interview loop I rewrote with two other managers and the recruiting team.`,
          short: `Ran hiring for the platform team: ${n} hires in a year with ${article(p)} ${p}% offer-accept rate.`,
        }
      },
      ({ r }) => {
        const n = r.int(40, 110), a = r.int(6, 12), b = r.int(2, 5)
        return {
          text: `Built a take-home exercise and scoring rubric, then interviewed ${n} candidates, which cut time to offer from ${a} weeks to ${b} and gave every panel the same evidence to weigh.`,
          short: `Built a take-home exercise and scoring rubric and interviewed ${n} candidates, cutting time to offer from ${a} weeks to ${b}.`,
        }
      },
    ],
  },
  {
    id: 'roadmap',
    tag: 'cross-team technical roadmaps',
    label: 'Leading cross-team technical roadmaps',
    req: ['Leading cross-team technical roadmaps with product, security and operations partners.'],
    resp: ['Drive a cross-team platform roadmap with product, security and operations.'],
    templates: [
      ({ r }) => {
        const n = r.int(4, 9), w = r.int(3, 9); const init = pick(r, INITIATIVES)
        return {
          text: `Coordinated a ${n}-team roadmap for the ${init} initiative, aligning product, security and operations on one delivery plan that landed ${w} weeks ahead of schedule.`,
          short: `Coordinated a ${n}-team roadmap for the ${init} initiative, aligning product, security and operations on one plan that landed ${w} weeks early.`,
        }
      },
      ({ r }) => {
        const n = r.int(3, 8), q = r.int(2, 4)
        return {
          text: `Wrote the platform roadmap with ${n} engineering leads — sequencing migrations, deprecations and staffing across ${q} quarters — and reviewed progress with the executive team each month.`,
          short: `Wrote the platform roadmap with ${n} engineering leads, sequencing migrations, deprecations and staffing across ${q} quarters.`,
        }
      },
    ],
  },
  {
    id: 'api',
    tag: 'stable, versioned APIs',
    label: 'Designing stable, versioned APIs for internal teams and partners',
    req: ['Designing stable, versioned APIs for internal teams and external partners.'],
    resp: ['Design stable, versioned APIs for internal teams and external partners.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(18, 64), m = r.int(6, 30); const sys = pick(r, d.sys)
        return {
          text: `Designed the public API for the ${sys}: ${n} endpoints, versioned contracts and a deprecation policy that let ${m} partner integrations upgrade without downtime.`,
          short: `Designed the public API for the ${sys}: ${n} endpoints, versioned contracts and a deprecation policy for ${m} partner integrations.`,
        }
      },
      ({ r }) => {
        const n = r.int(20, 60), a = r.int(70, 95)
        return {
          text: `Authored the API style guide and a linter enforcing it across ${n} services, so ${a}% of new endpoints shipped with consistent pagination, errors and idempotency keys.`,
          short: `Authored the API style guide and a linter enforcing it across ${n} services, covering pagination, errors and idempotency keys.`,
        }
      },
    ],
  },
  {
    id: 'vendor',
    tag: 'vendor and contract management',
    label: 'Managing vendor relationships and contracts',
    req: ['Managing vendor relationships and negotiating contracts.'],
    resp: ['Manage platform vendors and negotiate their contracts with procurement.'],
    templates: [
      ({ r, money }) => {
        const v = pick(r, VENDORS); const m = money(60, 420)
        return {
          text: `Renegotiated the ${v} vendor contract and consolidated two overlapping tools, saving ${m} a year without reducing coverage or raising the pager load.`,
          short: `Renegotiated the ${v} vendor contract and consolidated two overlapping tools, saving ${m} a year.`,
        }
      },
      ({ r, money }) => {
        const n = r.int(3, 8); const m = money(120, 780)
        return {
          text: `Ran a vendor review of ${n} platform tools with procurement and security, choosing which to renew, replace or retire, which saved ${m} a year and removed two unmaintained integrations.`,
          short: `Ran a vendor review of ${n} platform tools with procurement and security, which saved ${m} a year.`,
        }
      },
    ],
  },
  {
    id: 'launch',
    tag: 'revenue-generating features',
    label: 'Shipping customer-facing features that generate revenue',
    req: ['Shipping customer-facing features that generate revenue.'],
    resp: ['Ship platform capabilities that customers pay for.'],
    templates: [
      ({ r, d, money }) => {
        const n = r.int(12, 60); const product = pick(r, d.product); const m = money(400, 2400)
        return {
          text: `Launched ${product} for ${n} enterprise customers within a quarter of the first design review, which brought in ${m} of new annual recurring revenue in its first two quarters.`,
          short: `Launched ${product} for ${n} enterprise customers, bringing in ${m} of new annual recurring revenue in two quarters.`,
        }
      },
      ({ r, d }) => {
        const n = r.int(2, 6), p = r.int(8, 24); const product = pick(r, d.product)
        return {
          text: `Delivered ${product} in ${n} months with a team of four engineers and one designer, and it lifted trial-to-paid conversion ${p}% because customers could finally see results on day one.`,
          short: `Delivered ${product} in ${n} months with a team of four, lifting trial-to-paid conversion ${p}%.`,
        }
      },
    ],
  },
  {
    id: 'multiregion',
    tag: 'multi-region resilience',
    label: 'Multi-region resilience and disaster recovery',
    req: ['Designing for multi-region resilience and disaster recovery.'],
    resp: ['Design and exercise multi-region failover and disaster-recovery plans.'],
    templates: [
      ({ r, d }) => {
        const a = r.int(4, 15), n = r.int(5, 12); const sys = pick(r, d.sys)
        return {
          text: `Designed multi-region failover for the ${sys} with a ${a}-minute recovery-time objective, then proved it in a live game day involving ${n} teams and fixed every gap the exercise exposed.`,
          short: `Designed multi-region failover for the ${sys} with a ${a}-minute recovery-time objective, then proved it in a live game day with ${n} teams.`,
        }
      },
      ({ r }) => {
        const n = r.int(9, 14), a = r.int(2, 6)
        return {
          text: `Coordinated a company-wide disaster-recovery exercise involving ${n} teams, found ${a} untested runbooks and fixed each one before the next quarter’s exercise, which then ran without a single manual workaround.`,
          short: `Coordinated a company-wide disaster-recovery exercise involving ${n} teams and fixed ${a} untested runbooks.`,
        }
      },
    ],
  },
  {
    id: 'dbmigration',
    tag: 'PostgreSQL operations and migrations',
    label: 'Operating PostgreSQL and planning zero-downtime migrations',
    req: ['Operating PostgreSQL (or a similar database) and planning zero-downtime migrations.'],
    resp: ['Operate our PostgreSQL fleet and plan zero-downtime schema and version migrations.'],
    templates: [
      ({ r, d }) => {
        const v1 = r.pick(['11', '12']), v2 = r.pick(['14', '15']), n = r.int(9, 26); const unit = pick(r, d.unit)
        return {
          text: `Led a zero-downtime Postgres ${v1} to ${v2} upgrade across ${n} databases, moving the whole ${unit} data set through a short cutover window with no customer-visible errors.`,
          short: `Led a zero-downtime Postgres ${v1} to ${v2} upgrade across ${n} databases, moving the whole ${unit} data set.`,
        }
      },
      ({ r }) => {
        const n = r.int(35, 120), a = r.int(6, 15), b = r.int(1, 3)
        return {
          text: `Replaced ${n} ad hoc migration scripts with a reviewed expand-and-contract process and a shared checklist, cutting failed schema deploys from ${a} to ${b} a quarter.`,
          short: `Replaced ${n} ad hoc migration scripts with a reviewed expand-and-contract process, cutting failed schema deploys from ${a} to ${b} a quarter.`,
        }
      },
    ],
  },
  {
    id: 'capacity',
    tag: 'load testing and capacity planning',
    label: 'Load testing and capacity planning',
    req: ['Load testing and capacity planning ahead of peak traffic.'],
    resp: ['Plan capacity and run load tests ahead of every peak.'],
    templates: [
      ({ r, d }) => {
        const n = r.int(3, 9), k = r.int(4, 18); const op = pick(r, d.op)
        return {
          text: `Added load testing to the release process, catching ${n} capacity regressions before release and holding the ${op} path steady at ${k}k requests per second through the next peak.`,
          short: `Added load testing to the release process, catching ${n} capacity regressions before release on the ${op} path.`,
        }
      },
      ({ r, d }) => {
        const a = r.int(30, 60); const peak = pick(r, d.peak)
        return {
          text: `Built a traffic-replay harness and used it to size the fleet for the ${peak}, so the team provisioned ${a}% less headroom than the previous year and still finished with no throttling.`,
          short: `Built a traffic-replay harness and used it to size the fleet for the ${peak}, provisioning ${a}% less headroom than the previous year.`,
        }
      },
    ],
  },
]

// Optional closing sentence appended to a corpus bullet when it fits inside the
// 250-character ceiling. Context only: no digits, no new claims a listing
// requirement could hinge on, and the résumé `short` forms never carry them.
export const TAILS = {
  k8s: ['The runbook for it became the template for the next migration.', 'Product teams stopped planning releases around the migration calendar.'],
  latency: ['Support tickets about slow pages dropped off within a quarter.', 'The fix went into the shared client library, so other teams inherited it.'],
  cost: ['Finance now reviews the numbers in its monthly planning meeting.', 'Owners started retiring unused resources without being asked.'],
  reliability: ['The change removed the most common reason for a night-time page.', 'Product teams began citing the error budget in their own planning.'],
  oncall: ['New engineers now join the rotation after a single shadow week.', 'Other teams still copy the approach as their reference.'],
  observability: ['Engineers now check the shared view first when a customer reports slowness.', 'The shared view ended the arguments about whose service was slow.'],
  iac: ['Reviewers can now see every infrastructure change before it ships.', 'Nobody has to remember how an environment was built.'],
  cicd: ['Engineers now trust the tooling enough to stop asking the platform team for help.', 'The tooling is documented well enough to run without the platform team.'],
  streaming: ['Consumers can replay a bad day without asking the producing team.', 'The pipeline has carried two peak seasons without a redesign.'],
  dataquality: ['Analysts now hear about a bad feed before their dashboards do.', 'Producers own their schemas, and the checks say so in the pull request.'],
  security: ['Evidence is collected continuously instead of the week before the audit.', 'Engineers now treat the audit checklist as part of the definition of done.'],
  mentoring: ['Several of them now run design reviews of their own.', 'Two of them later mentored newer engineers themselves.'],
  hiring: ['New hires reached full on-call duty faster than the previous cohort.', 'The process is still in use for every platform opening.'],
  roadmap: ['Each team could see which of its dependencies had a date.', 'The plan survived two changes of priority without a rewrite.'],
  api: ['Partners stopped filing tickets about surprise changes.', 'The guidelines are now the first link in the onboarding checklist.'],
  vendor: ['The renewal calendar is now tracked next to the budget.', 'Owners can see which tools overlap before they buy another.'],
  launch: ['Sales cited it in most of the enterprise renewals that quarter.', 'Support wrote fewer how-to articles because the feature explained itself.'],
  multiregion: ['The exercise became a yearly event on the engineering calendar.', 'Every runbook now states the region it assumes.'],
  dbmigration: ['Schema changes stopped being the thing teams dreaded on release day.', 'The process is now the standard path for every schema change.'],
  capacity: ['Capacity reviews now start from measured curves, not guesses.', 'The tests now run on every release candidate.'],
}

export const TOPIC_BY_ID = Object.fromEntries(TOPICS.map(topic => [topic.id, topic]))

// Topics every listing carries, in priority order (the first three are the
// requirements the evidence plan marks "highest").
export const CORE_TOPIC_IDS = ['k8s', 'reliability', 'cost', 'mentoring', 'latency', 'security', 'vendor', 'cicd']
export const EXTRA_TOPIC_ORDER = ['oncall', 'observability', 'streaming', 'roadmap', 'iac', 'api', 'dbmigration', 'hiring', 'launch', 'multiregion', 'dataquality', 'capacity']

// Independent personal projects for the projects write-up. Each has a
// name, a context sentence, a build sentence and a result sentence; none of
// them names an employer.
export const PROJECT_THEMES = [
  {
    name: 'Runbook Linter',
    stack: 'Go, YAML',
    build: (r) => [
      'A command-line tool that lints on-call runbooks for missing owners, stale links and steps that cannot be run as written.',
      `I wrote it after a page sat unanswered for ${r.int(20, 50)} minutes because the runbook pointed at a dashboard that no longer existed.`,
      `It now runs in the pull-request checks of ${r.int(6, 24)} repositories and has flagged ${r.int(60, 240)} broken runbook steps.`,
    ],
  },
  {
    name: 'Deploy Timeline',
    stack: 'TypeScript, PostgreSQL',
    build: (r) => [
      'A small web app that overlays deploys, feature-flag flips and config changes on top of latency and error graphs.',
      `The idea was to make the first question in every incident, what changed, answerable in about ${r.int(5, 15)} seconds.`,
      `Teams that adopted it reported that they found the triggering change in the first ${r.int(3, 8)} minutes of an incident instead of the first hour.`,
    ],
  },
  {
    name: 'Spot Scheduler',
    stack: 'Go, Kubernetes',
    build: (r) => [
      'A Kubernetes operator that places interruptible batch jobs on spot nodes and checkpoints them before reclaim.',
      `I built it to stop paying on-demand prices for work that could wait, and it handled ${r.int(30, 90)} thousand job runs in its first year.`,
      `Maintainers of other clusters have used it to cut batch compute spend by between ${r.int(25, 40)}% and ${r.int(50, 70)}%.`,
    ],
  },
  {
    name: 'Schema Drift Watch',
    stack: 'Python, SQL',
    build: (r) => [
      'A scheduled job that compares warehouse schemas against the documented contracts and posts a diff when a column changes type or disappears.',
      `It grew out of a week lost to a silent column rename, and it has caught ${r.int(14, 60)} breaking changes before a dashboard did.`,
      'The diff format is deliberately small so a reviewer can read it in the pull request itself.',
    ],
  },
  {
    name: 'Load Replay',
    stack: 'Rust, Kafka',
    build: (r) => [
      'A traffic-replay harness that records production request shapes, strips personal data and plays them back against a staging stack at chosen multiples of real load.',
      `Using it, I found ${r.int(2, 6)} capacity cliffs that synthetic benchmarks had missed, including a connection-pool limit that only appeared above ${r.int(3, 6)} times normal traffic.`,
      `The project has ${r.int(300, 1400)} GitHub stars and a small group of regular contributors.`,
    ],
  },
  {
    name: 'Queue Doctor',
    stack: 'Python, Kafka',
    build: (r) => [
      'A diagnostic CLI that inspects a stuck consumer group and reports the partition, offset and message that is blocking it.',
      `It replaced a ${r.int(30, 60)}-minute manual procedure with a single command that finishes in about ${r.int(10, 40)} seconds.`,
      'Several teams have adopted it as the first step in their consumer-lag runbooks.',
    ],
  },
  {
    name: 'Cost Lens',
    stack: 'TypeScript, SQL',
    build: (r) => [
      'A per-team cloud cost explorer that joins billing exports with deploy metadata so an engineer can see what a change cost.',
      `Finance used it to trace ${r.int(18, 60)} thousand dollars a month of unowned spend back to named services within its first quarter.`,
      'The code is open source and documented well enough that two other teams stood it up without asking me for help.',
    ],
  },
]
