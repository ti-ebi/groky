# Contributing

Groky is in its initial development phase. Community contributions are currently accepted through GitHub Issues.

## Before opening an issue

1. Search the [existing issues](https://github.com/ti-ebi/groky/issues) to avoid duplicates.
2. Choose the issue form that best matches your contribution.
3. Keep each issue focused on one bug, feature, or documentation improvement.
4. Include enough context for someone else to understand and reproduce the problem.

## What to include

For a bug report, include:

- The Groky version and operating system.
- The Grok Build CLI version when relevant.
- Clear reproduction steps.
- The expected and actual behavior.
- Sanitized screenshots or logs when they help explain the problem.

For a feature request, describe:

- The problem or use case.
- The outcome you would like.
- Alternatives or workarounds you considered.

Documentation corrections and improvements are also welcome through the documentation issue form.

## What happens next

A maintainer will review the issue, check whether it fits the project, and request more information when needed. The issue remains the source of truth for its scope and status. Implementation is handled by a maintainer unless someone is explicitly invited to work on the accepted issue.

## Pull requests

Please do not open an unsolicited pull request. A maintainer may invite you to implement an accepted issue and will provide the expected scope and verification steps before work begins.

When a maintainer requests a pull request:

1. Branch from `develop`.
2. Keep the change focused on the agreed issue.
3. Run the checks documented in `AGENTS.md`.
4. Include the issue reference and verification results in the pull request.
5. Open the pull request against `develop`.

## Sensitive information

Do not include credentials, API keys, `.env` files, prompts, source code from private projects, Grok session data, or captured raw ACP traffic in an issue, attachment, log, or pull request.
