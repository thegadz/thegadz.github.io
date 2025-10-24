// Alpine.js Data Store for GameStore
document.addEventListener('alpine:init', () => {
    Alpine.data('gameStore', () => ({
        games: [],
        filteredGames: [],
        categories: [],
        searchTerm: '',
        selectedCategory: '',
        sortBy: 'name',
        totalGames: 0,
        averagePrice: '$0.00',
        topRatedGame: 'N/A',

        async loadGames() {
            try {
                const response = await fetch('games.csv');
                const csvText = await response.text();
                this.parseCSV(csvText);
                this.filteredGames = [...this.games];
                this.updateStatistics();
            } catch (error) {
                console.error('Error loading games:', error);
                // Fallback data in case CSV fails to load
                this.games = this.getFallbackGames();
                this.filteredGames = [...this.games];
                this.updateStatistics();
            }
        },

        parseCSV(csvText) {
            const lines = csvText.split('\n').filter(line => line.trim() !== '');
            const headers = lines[0].split(',');
            
            this.games = lines.slice(1).map((line, index) => {
                const values = this.parseCSVLine(line);
                const game = {};
                headers.forEach((header, i) => {
                    game[header.trim()] = values[i] ? values[i].trim() : '';
                });
                // Convert numeric fields
                game.price = parseFloat(game.price) || 0;
                game.rating = parseFloat(game.rating) || 0;
                game.id = parseInt(game.id) || index + 1;
                return game;
            });

            // Extract unique categories
            this.categories = [...new Set(this.games.map(game => game.category))].sort();
        },

        parseCSVLine(line) {
            const result = [];
            let current = '';
            let inQuotes = false;
            
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    result.push(current);
                    current = '';
                } else {
                    current += char;
                }
            }
            
            result.push(current);
            return result;
        },

        filterGames() {
            let filtered = [...this.games];

            // Filter by search term
            if (this.searchTerm) {
                const term = this.searchTerm.toLowerCase();
                filtered = filtered.filter(game => 
                    game.name.toLowerCase().includes(term) ||
                    game.description.toLowerCase().includes(term) ||
                    game.category.toLowerCase().includes(term)
                );
            }

            // Filter by category
            if (this.selectedCategory) {
                filtered = filtered.filter(game => game.category === this.selectedCategory);
            }

            this.filteredGames = filtered;
            this.sortGames();
        },

        sortGames() {
            this.filteredGames.sort((a, b) => {
                switch (this.sortBy) {
                    case 'name':
                        return a.name.localeCompare(b.name);
                    case 'price':
                        return a.price - b.price;
                    case 'rating':
                        return b.rating - a.rating;
                    default:
                        return 0;
                }
            });
        },

        updateStatistics() {
            this.totalGames = this.games.length;
            
            if (this.games.length > 0) {
                const totalPrice = this.games.reduce((sum, game) => sum + game.price, 0);
                this.averagePrice = '$' + (totalPrice / this.games.length).toFixed(2);
                
                const topRated = this.games.reduce((max, game) => 
                    game.rating > max.rating ? game : max
                );
                this.topRatedGame = topRated.name;
            }
        },

        getFallbackGames() {
            return [
                {
                    id: 1,
                    name: "Cyberpunk 2077",
                    category: "RPG",
                    price: 59.99,
                    rating: 4.2,
                    platform: "PC",
                    description: "Futuristic open-world RPG set in Night City"
                },
                {
                    id: 2,
                    name: "The Legend of Zelda: Breath of the Wild",
                    category: "Adventure",
                    price: 59.99,
                    rating: 4.8,
                    platform: "Nintendo Switch",
                    description: "Epic adventure in the kingdom of Hyrule"
                },
                {
                    id: 3,
                    name: "Minecraft",
                    category: "Sandbox",
                    price: 26.95,
                    rating: 4.7,
                    platform: "Multi-platform",
                    description: "Creative sandbox game with endless possibilities"
                }
            ];
        }
    }));
});

// Smooth scrolling for navigation links
document.addEventListener('DOMContentLoaded', function() {
    const links = document.querySelectorAll('a[href^="#"]');
    
    links.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href').substring(1);
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});

// Add some interactive features
document.addEventListener('DOMContentLoaded', function() {
    // Add click handlers for game cards
    document.addEventListener('click', function(e) {
        if (e.target.textContent === 'Buy Now') {
            e.preventDefault();
            alert('Purchase functionality would be implemented here!');
        }
        
        if (e.target.textContent === 'Add to Wishlist') {
            e.preventDefault();
            alert('Added to wishlist!');
        }
    });
});
