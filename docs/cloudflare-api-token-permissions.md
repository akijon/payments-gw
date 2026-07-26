# Cloudflare API Token Permissions for Wrangler

## Current Issue

The current `CLOUDFLARE_API_TOKEN` lacks sufficient permissions for Wrangler 4.x deployment operations.

## Required Permissions

Based on Wrangler 4.x documentation, the API token needs the following permissions:

### Account Permissions
- **Account:Read** - Required to read account information
- **User:Read** - Required for user authentication
- **User -> Memberships:Read** - Required to read account membership

### Workers Permissions  
- **Workers Scripts:Edit** - Deploy and update Workers
- **Workers Scripts:Read** - Read Worker scripts and deployments
- **Workers:Edit** - Manage Worker configuration

### D1 Permissions
- **D1:Edit** - Manage D1 databases and execute queries
- **D1:Read** - Read D1 database information

### KV Permissions
- **Workers KV Storage:Edit** - Manage KV namespaces and data
- **Workers KV Storage:Read** - Read KV data

### Zone Permissions (if deploying to custom domain)
- **Zone:Read** - Read zone information
- **Zone Settings:Edit** - Configure zone settings (if needed)

## How to Create the Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Custom Token" template
4. Add all the permissions listed above
5. Set Account and Zone resources as needed
6. Copy the token and update the environment variable

## Alternative: Use Global API Key

For development, you can use the Global API Key instead:
- Set `CLOUDFLARE_EMAIL` and `CLOUDFLARE_API_KEY` environment variables
- Remove `CLOUDFLARE_API_TOKEN` 
- Global API Key has all permissions but is less secure

## Testing the Token

After updating the token, test with:
```bash
npx wrangler whoami
npx wrangler deployments list
```