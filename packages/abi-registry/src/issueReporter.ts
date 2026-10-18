/**
 * Reports schema mismatches to an issue tracker or ticketing system.
 */
export interface IssueReporter {
  /**
   * Reports a schema mismatch.
   *
   * @param params Details of the mismatch and affected contract
   * @returns The created issue URL or identifier
   */
  reportMismatch(params: MismatchReportParams): Promise<string>;
}

/**
 * Parameters for reporting a schema mismatch between a submitted schema and on-chain spec.
 */
export type MismatchReportParams = {
  /** The contract ID where the mismatch occurred */
  contractId: string;
  /** Name of the contract */
  contractName: string;
  /** Differences detected between the submitted schema and on-chain spec */
  diffs: { path: string; submitted: unknown; onChain: unknown }[];
  /** Version string of the submitted schema, if known */
  submittedVersion?: string;
  /** Previous verification status before this mismatch was detected */
  previousStatus?: string;
};

/**
 * Reports schema mismatches as GitHub issues in a specified repository.
 */
export class GitHubIssueReporter implements IssueReporter {
  /**
   * @param token GitHub API token with issue creation permissions
   * @param repo Target repository in "owner/repo" format
   */
  constructor(
    private readonly token: string,
    private readonly repo: string,
  ) {}

  /**
   * Creates a GitHub issue detailing the schema mismatch.
   *
   * @param params Details of the mismatch
   * @returns A promise resolving to the URL of the created issue
   * @throws {Error} If the GitHub API request fails
   */
  async reportMismatch(params: MismatchReportParams): Promise<string> {
    const title = `[ABI Registry] Schema mismatch detected for ${params.contractName} (${params.contractId.slice(0, 8)}…)`;
    const body = [
      `## ABI Schema Mismatch`,
      ``,
      `Contract **${params.contractName}** (\`${params.contractId}\`) has a submitted schema that does not match its on-chain contract spec.`,
      ``,
      `| Field | Detail |`,
      `|---|---|`,
      `| **Contract** | \`${params.contractId}\` |`,
      `| **Name** | ${params.contractName} |`,
      params.submittedVersion ? `| **Submitted version** | ${params.submittedVersion} |` : null,
      params.previousStatus ? `| **Previous verdict** | ${params.previousStatus} |` : null,
      ``,
      `### Differences`,
      ``,
      params.diffs.length === 0
        ? `No specific field diffs recorded.`
        : `| # | Path | Submitted | On-chain |`,
      `|---|---|---|---|`,
    ].concat(
      params.diffs.map(
        (d, i) =>
          `| ${i + 1} | \`${d.path}\` | \`${JSON.stringify(d.submitted)}\` | \`${JSON.stringify(d.onChain)}\` |`,
      ),
    );

    body.push(``, `---`, `_Automatically reported by ABI Registry Verification Pipeline_`);

    const response = await fetch(`https://api.github.com/repos/${this.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title,
        body: body.filter(Boolean).join("\n"),
        labels: ["abi-registry", "schema-mismatch", "automated"],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      throw new Error(`GitHubIssueReporter: failed to create issue (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { html_url?: string };
    return data.html_url ?? `https://github.com/${this.repo}/issues`;
  }
}

/**
 * Issue reporter that discards mismatch reports without creating issues.
 */
export class NoopIssueReporter implements IssueReporter {
  /**
   * Discards the mismatch report.
   *
   * @param _params Details of the mismatch (ignored)
   * @returns An empty string
   */
  async reportMismatch(_params: MismatchReportParams): Promise<string> {
    return "";
  }
}
