export interface LegalSection {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  /** Paragraphs rendered after the bullet list. */
  after?: readonly string[];
}

export interface LegalDocumentContent {
  intro: readonly string[];
  sections: readonly LegalSection[];
}
