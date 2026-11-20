---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Formatted text can be read a run at a time

The new alpha method `runs(start?, end?)` of [`FormattedText`](https://fluidframework.com/docs/api/fluid-framework/formattedtext-namespace) nodes reads the text and its formatting a run at a time.
Each `FormattedText.TextRun` is either a maximal stretch of characters with equal formats or a single atom of another kind, and gives its `start`, `length` and `text`, its `format` and, for an atom that isn't a character, the `atom`.

```typescript
for (const run of text.runs()) {
	render(run.text, run.format);
}
```

The atoms of a run aren't given node objects: only reading a run's `format` or `atom` creates the nodes of its first atom.
In a section of about 950 characters in 120 runs, reading every run's text and formatting with `runs()` takes 10.7 ms the first time and 4.4 ms after that, against 12.0 and 5.1 ms with `getUniformRun` and `getString`, and 85 and 20 ms reading each atom with `charactersWithFormatting`.
