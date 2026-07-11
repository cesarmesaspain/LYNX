# LYNX Commercial Demo

## Positioning

LYNX gives coding agents a local code intelligence layer before they waste
context reading files. The demo should prove three things:

1. LYNX finds the right symbols quickly.
2. Semantic ranking improves ambiguous searches.
3. The product measures estimated context saved.

Do not sell provider/model details. Say "semantic ranking" or "semantic lift".

## Demo Script

```bash
# Benchmark with natural-language queries
node dist/cli.js benchmark /Users/admin/Desktop/WORKMAT \
  --name workmat-lynx \
  --query "contact form,send email,pricing,dashboard,booking"

node dist/cli.js benchmark /Users/admin/Desktop/MENTESIA/NEW_WEBSITE \
  --name mentesia-lynx \
  --query "send email,contact form,scenario runtime,dashboard,vault"

# Generate HTML reports
node dist/cli.js report workmat-lynx
node dist/cli.js report mentesia-lynx
```

Open:

```text
/Users/admin/.lynx/reports/workmat-lynx-value-report.html
/Users/admin/.lynx/reports/mentesia-lynx-value-report.html
```

## Current Evidence

WORKMAT:

```text
Average local search latency: 13ms
Semantic rank changed: 3/5 queries
Semantic top changed: 1/5 queries
Estimated semantic cost: $0.000358
Estimated tokens saved in benchmark: 82,080
```

MENTESIA:

```text
Average local search latency: 41ms
Semantic rank changed: 4/5 queries
Semantic top changed: 3/5 queries
Estimated semantic cost: $0.000560
Estimated tokens saved in benchmark: 136,800
```

Strongest example:

```text
Query: send email
BM25 top: lib.auth.passwordResetEmail.sendPasswordResetEmail
Semantic rerank top: lib.mailing.provider.sendSmtpMail
```

This proves the commercial value: fast local search + cheap rerank for ambiguous queries.

## Pricing Argument

If LYNX saves even 100K tokens per developer per week, the value is not the
SQLite graph itself. The value is reducing agent waste, shortening discovery,
and making code tasks more predictable.

Recommended starting price:

```text
Free: local graph, limited LOC
Pro: $9-$12/month, semantic ranking, metrics, reports
Team: $29/user/month or $99/team starter, shared reports and policy
```

## Product Rule

Do not add more tools until these are excellent:

- install
- pack_context
- search_graph
- hook augment
- benchmark
- report
- doctor
