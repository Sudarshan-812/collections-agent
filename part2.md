# Part 2 — Thought Exercise: Predictive Concrete Defect Analytics

_Target: one page, no code. Fill in after Part 1 is done, or first if you want to bank an easy deliverable early — it doesn't depend on the code._

## What's being asked

A construction firm wants to "predict defects before they happen" from: mix design docs for 3 past projects, plus 30-50 defect photos per project, each captioned with defect type only (no location, severity, date, or quantity).

## What can be built, and why

_E.g.: a descriptive/retrospective analysis correlating mix design parameters (water-cement ratio, admixtures, aggregate type) with the observed defect-type distribution per project; a supervised image classifier for defect TYPE (captions give labels, so this is a real, buildable task) to speed up future QA tagging. Explain why: labels exist for classification; mix docs give per-project features for correlation; sample is small but usable for a hypothesis-generating first pass._

## What can't be built, and what you'd tell the client

_E.g.: a genuine leading-indicator predictive model — cannot be built from this data. Say why plainly:_
- _Only 3 projects = 3 confounds; can't separate "this mix" from "this site/crew/weather."_
- _No non-defect ("clean") photos — no negative examples, so you can't learn what "no defect" looks like or compute a defect rate, only catalog defect types that occurred._
- _Mix design docs describe the intended/target mix, not what was actually batched and poured — no as-delivered batch tickets, slump tests, water added on site, or curing conditions._
- _No time dimension — a photo taken after a defect is visible is not a "before it happens" signal._

_Be direct with the client about this gap — don't oversell a correlation study as prediction._

## Three things to ask for, and what each unlocks

1. **Non-defect control photos** (same locations/pours, no defect) — _unlocks: any real classifier (needs negative examples) and an actual defect rate, not just a defect catalog._
2. **As-poured batch/curing/environmental data, timestamped and tied to pour location** (slump, water added on site, ambient temp/humidity, curing duration, formwork strike time) — _unlocks: the actual leading indicators; this is the difference between "predict before" and "classify after."_
3. **More projects with consistent structured metadata** (severity, exact location, inspector, batch ID) — _unlocks: enough statistical power and variation to separate mix effects from site/crew effects, and a dataset that could support a real predictive model later._
