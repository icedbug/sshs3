import type { KbPageKind } from "@shared/types/aiHub";

export interface PageDraft {
  id?: string;
  kind: KbPageKind;
  title: string;
  when: string;
  targets: string;
  keys: string;
  body: string;
}

export const KINDS: { kind: KbPageKind; title: string; hint: string; template: string }[] = [
  {
    kind: "system",
    title: "How things are set up",
    hint: "What runs where, what depends on what, what normal looks like.",
    template: "## What it is\n\n## Where it runs\n\n## What depends on it\n\n## What normal looks like\n",
  },
  {
    kind: "procedure",
    title: "Procedures",
    hint: "How to do one thing: steps, how to verify, what not to do.",
    template: "## When to use this\n\n## Steps\n1. \n\n## Verify\n\n## Undo\n\n## Do not\n",
  },
  {
    kind: "troubleshooting",
    title: "Troubleshooting",
    hint: "One symptom: likely causes in order, the check that tells them apart, red herrings.",
    template: "## Symptom\n\n## Likely causes, most likely first\n1. Cause — the check that confirms it — the fix\n\n## Red herrings\n",
  },
];

export const emptyPage = (kind: KbPageKind = "troubleshooting", title = ""): PageDraft => ({
  kind,
  title,
  when: "",
  targets: "",
  keys: "",
  body: KINDS.find((k) => k.kind === kind)!.template,
});

