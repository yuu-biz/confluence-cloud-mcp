# Security policy

## Credential handling

This server accepts an Atlassian email address and API token from environment variables or the Claude Desktop Extension's sensitive configuration. Credentials are never written to files, logs, MCP responses, or error messages. Keep `.env` local and rotate a token if it may have been exposed.

## Network scope

The normal client only sends requests to the configured Confluence Cloud site over HTTPS. Custom domains are rejected unless `CONFLUENCE_ALLOW_CUSTOM_DOMAIN=true` is set explicitly. The raw REST tool accepts paths only under `/wiki/api/v2/` or `/wiki/rest/api/`; it cannot receive an arbitrary URL or host.

## Write and local-file scope

Named write tools are available for the normal page and comment workflows. Deleting content, raw write requests, and reading a local file for attachment upload require both an environment opt-in and an explicit `confirm: true` input. Review the tool call before enabling these controls.

## Reporting

Please open a private security report with the repository maintainers before publicly disclosing a vulnerability.
