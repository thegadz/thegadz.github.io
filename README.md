# GameStore Website

A modern gaming website built with Alpine.js and Pico CSS, designed for GitHub Pages deployment.

## Features

- **Modern Design**: Clean, gaming-themed interface with dark mode
- **Interactive Search**: Real-time game filtering and search functionality
- **CSV Data Integration**: Games data loaded from CSV file
- **Responsive Layout**: Works perfectly on desktop and mobile devices
- **Alpine.js Integration**: Lightweight JavaScript framework for interactivity
- **Pico CSS**: Minimal CSS framework for clean styling

## Technologies Used

- **HTML5**: Semantic markup structure
- **Alpine.js**: Reactive JavaScript framework
- **Pico CSS**: Minimal CSS framework
- **CSV**: Data storage format for game information
- **GitHub Pages**: Static site hosting

## Project Structure

```
├── index.html          # Main HTML file
├── script.js           # Alpine.js functionality and CSV parsing
├── styles.css          # Custom CSS styling
├── games.csv           # Game data in CSV format
└── README.md           # This file
```

## Game Data

The website displays 25 popular games with the following information:
- Game name and description
- Category (RPG, Action, Adventure, etc.)
- Price and rating
- Platform availability
- Interactive filtering and sorting

## Features Overview

### Search and Filter
- Real-time search across game names, descriptions, and categories
- Category-based filtering
- Sorting by name, price, or rating

### Game Cards
- Attractive card-based layout
- Hover effects and animations
- Buy Now and Add to Wishlist buttons
- Platform badges and rating stars

### Statistics Dashboard
- Total games count
- Number of categories
- Average price calculation
- Top-rated game display

## Deployment

This website is designed for GitHub Pages deployment:

1. Push all files to a GitHub repository
2. Enable GitHub Pages in repository settings
3. Select the main branch as the source
4. Your site will be available at `https://username.github.io/repository-name`

## Browser Support

- Modern browsers with ES6+ support
- Mobile responsive design
- Progressive enhancement approach

## Customization

You can easily customize the website by:
- Modifying `games.csv` to add/remove games
- Updating `styles.css` for different color schemes
- Extending `script.js` for additional functionality
- Adding new sections to `index.html`

## License

This project is open source and available under the MIT License.
