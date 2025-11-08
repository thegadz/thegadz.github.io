// Alpine.js Data Store for GameStore

document.addEventListener('alpine:init', () => {
    Alpine.data('gameStore', () => ({
        games: [],
        filteredGames: [],
        categories: [],
        types: [],
        searchTerm: '',
        selectedCategory: '',
        selectedType: '',
        sortBy: 'name',
        totalGames: 0,
        averagePrice: 'Rp 0',
        topRatedGame: 'N/A',
        isLoading: true,
        errorMessage: '',
        cart: [],
        cartTotal: 0,
        cartCount: 0,

        async loadGames() {
            await window.GoogleSheet.loadGames(this);
        },

        async initializeVoucherPage() {
            await this.loadGames();
            this.initCart();

            if (!this.selectedType) {
                const defaultType = this.types.find(type => type && type.toLowerCase() === 'voucher') || this.types[0] || '';
                if (defaultType) {
                    this.selectedType = defaultType;
                }
            }

            this.filterGames();
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

            // Filter by type
            if (this.selectedType) {
                filtered = filtered.filter(game => game.type === this.selectedType);
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
                this.averagePrice = window.formatIDR(totalPrice / this.games.length);
                
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
        },
        
        // Cart methods
        initCart() {
            this.cart = CartManager.getCart();
            this.updateCartTotals();
        },
        
        updateCartTotals() {
            this.cartTotal = CartManager.getCartTotal();
            this.cartCount = CartManager.getCartCount();
        },
        
        isInCart(gameId) {
            return this.cart.some(item => item.id === gameId);
        },
        
        getCartQuantity(gameId) {
            const item = this.cart.find(item => item.id === gameId);
            return item ? item.quantity : 0;
        },
        
        addToCart(game) {
            this.cart = CartManager.addToCart(game);
            this.updateCartTotals();
            // Show visual feedback (could be improved with toast notification)
            this.showCartNotification(`${game.name} added to cart`);
        },
        
        removeFromCart(gameId) {
            this.cart = CartManager.removeFromCart(gameId);
            this.updateCartTotals();
        },
        
        updateQuantity(gameId, quantity) {
            this.cart = CartManager.updateQuantity(gameId, quantity);
            this.updateCartTotals();
        },
        
        clearCart() {
            this.cart = CartManager.clearCart();
            this.updateCartTotals();
        },
        
        goToCheckout() {
            if (this.cart.length === 0) return;
            window.location.href = 'payment.html';
        },
        
        showCartNotification(message) {
            // Simple notification without alert - create a toast-style notification
            const notification = document.createElement('div');
            notification.className = 'cart-notification';
            notification.textContent = message;
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.classList.add('show');
            }, 10);
            
            setTimeout(() => {
                notification.classList.remove('show');
                setTimeout(() => notification.remove(), 300);
            }, 3000);
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
