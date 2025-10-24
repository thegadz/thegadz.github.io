# GitHub Pages Configuration

This file ensures proper GitHub Pages deployment.

## Deployment Instructions

1. **Create a GitHub Repository**
   - Create a new repository on GitHub
   - Name it anything you prefer (e.g., "gamestore", "my-gaming-site")

2. **Upload Files**
   - Upload all files (`index.html`, `script.js`, `styles.css`, `games.csv`, `README.md`) to the repository
   - Commit and push to the main branch

3. **Enable GitHub Pages**
   - Go to repository Settings
   - Scroll down to "Pages" section
   - Under "Source", select "Deploy from a branch"
   - Choose "main" branch and "/ (root)" folder
   - Click "Save"

4. **Access Your Site**
   - Your site will be available at: `https://yourusername.github.io/repository-name`
   - It may take a few minutes to deploy

## File Structure for GitHub Pages

```
repository-root/
├── index.html          # Main page (required)
├── script.js           # JavaScript functionality
├── styles.css          # Custom styling
├── games.csv           # Game data
├── README.md           # Documentation
└── .nojekyll           # Optional: prevents Jekyll processing
```

## Notes

- GitHub Pages serves static files only
- All files must be in the root directory or properly linked
- The CSV file will be accessible via HTTP requests
- Alpine.js and Pico CSS are loaded from CDN (no local dependencies)

## Troubleshooting

If the site doesn't load properly:
1. Check that all files are in the root directory
2. Verify file names match exactly (case-sensitive)
3. Ensure GitHub Pages is enabled in repository settings
4. Check the Actions tab for any deployment errors
