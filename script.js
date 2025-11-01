// Alpine.js Data Store for GameStore

// Configuration: Google Sheets CSV Export
// IMPORTANT SETUP STEPS:
// 1. Create a Google Sheet with your game data (same format as games.csv)
// 2. Click "Share" button (top right) → Change to "Anyone with the link" → "Viewer"
// 3. Copy the Sheet ID from the URL: docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit
// 4. Update GOOGLE_SHEET_ID and GOOGLE_SHEET_NAME below
// 
// The sheet does NOT need to be published to web, just shared as view-only.
// The code will try multiple URL formats automatically.

const GOOGLE_SHEET_ID = '1a5j9jRPAa1K5qBbQuPzrmx7C9qBGew9vpZuJhC2E-C8';
const GOOGLE_SHEET_NAME = 'Sheet1'; // Exact name of the tab/sheet (case-sensitive)

// Alternative: You can also set a direct export URL if you prefer:
// const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/export?format=csv&gid=0';
const GOOGLE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(GOOGLE_SHEET_NAME)}`;
const USE_GOOGLE_SHEET = GOOGLE_SHEET_ID && GOOGLE_SHEET_ID.trim() !== '';

// Currency Formatter for IDR (Indonesian Rupiah)
// Make it globally accessible for Alpine.js templates
window.formatIDR = (amount) => {
    // Format number with dots as thousands separator
    // IDR typically doesn't use decimals for display, so we'll round to nearest integer
    const roundedAmount = Math.round(amount);
    return 'Rp ' + roundedAmount.toLocaleString('id-ID');
};
const formatIDR = window.formatIDR; // Keep for internal use

// Cart Management Functions (localStorage)
const CartManager = {
    getCart: () => {
        try {
            const cart = localStorage.getItem('gameStoreCart');
            return cart ? JSON.parse(cart) : [];
        } catch (e) {
            console.error('Error reading cart from localStorage:', e);
            return [];
        }
    },
    
    saveCart: (cart) => {
        try {
            localStorage.setItem('gameStoreCart', JSON.stringify(cart));
        } catch (e) {
            console.error('Error saving cart to localStorage:', e);
        }
    },
    
    addToCart: (game) => {
        const cart = CartManager.getCart();
        const existingItem = cart.find(item => item.id === game.id);
        
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            cart.push({ ...game, quantity: 1 });
        }
        
        CartManager.saveCart(cart);
        // Dispatch event to update cart badge across pages
        window.dispatchEvent(new CustomEvent('cartUpdated'));
        return cart;
    },
    
    removeFromCart: (gameId) => {
        const cart = CartManager.getCart().filter(item => item.id !== gameId);
        CartManager.saveCart(cart);
        window.dispatchEvent(new CustomEvent('cartUpdated'));
        return cart;
    },
    
    updateQuantity: (gameId, quantity) => {
        if (quantity <= 0) {
            return CartManager.removeFromCart(gameId);
        }
        
        const cart = CartManager.getCart();
        const item = cart.find(item => item.id === gameId);
        if (item) {
            item.quantity = quantity;
        }
        CartManager.saveCart(cart);
        window.dispatchEvent(new CustomEvent('cartUpdated'));
        return cart;
    },
    
    clearCart: () => {
        CartManager.saveCart([]);
        window.dispatchEvent(new CustomEvent('cartUpdated'));
        return [];
    },
    
    getCartTotal: () => {
        const cart = CartManager.getCart();
        return cart.reduce((total, item) => total + (item.price * item.quantity), 0);
    },
    
    getCartCount: () => {
        const cart = CartManager.getCart();
        return cart.reduce((count, item) => count + item.quantity, 0);
    }
};

document.addEventListener('alpine:init', () => {
    Alpine.data('gameStore', () => ({
        games: [],
        filteredGames: [],
        categories: [],
        searchTerm: '',
        selectedCategory: '',
        sortBy: 'name',
        totalGames: 0,
        averagePrice: 'Rp 0',
        topRatedGame: 'N/A',
        isLoading: true,
        errorMessage: '',
        cart: [],
        cartTotal: 0,
        cartCount: 0,

        decodeDataUrl(dataUrl) {
            // Handle data URLs like: data:text/csv;base64,BASE64_STRING
            if (dataUrl.startsWith('data:')) {
                const base64Match = dataUrl.match(/data:.*?;base64,(.+)/);
                if (base64Match && base64Match[1]) {
                    try {
                        // Decode base64 to text
                        const base64String = base64Match[1];
                        const decodedText = atob(base64String);
                        console.log('Decoded base64 data URL, got', decodedText.length, 'characters');
                        return decodedText;
                    } catch (decodeError) {
                        console.warn('Failed to decode base64 data URL:', decodeError);
                        throw new Error('Invalid base64 data URL format');
                    }
                }
            }
            return dataUrl; // Not a data URL, return as-is
        },

        async fetchWithCorsProxy(url) {
            // List of CORS proxy services (free, public proxies)
            // Each entry is: [proxyUrlTemplate, needsJsonParse]
            const corsProxies = [
                [`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, true],
                [`https://corsproxy.io/?${encodeURIComponent(url)}`, false],
                [`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, false],
            ];
            
            for (const [proxyUrl, needsJsonParse] of corsProxies) {
                try {
                    console.log('Trying CORS proxy:', proxyUrl.substring(0, 50) + '...');
                    const response = await fetch(proxyUrl, {
                        method: 'GET',
                        headers: {
                            'Accept': 'text/csv, text/plain, */*'
                        }
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Proxy HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    let data = await response.text();
                    
                    // Check if it's a data URL (base64 encoded)
                    if (data.startsWith('data:')) {
                        console.log('Proxy returned data URL, decoding base64...');
                        data = this.decodeDataUrl(data);
                    }
                    // Some proxies return JSON with the content inside
                    else if (needsJsonParse || proxyUrl.includes('allorigins.win')) {
                        try {
                            const json = JSON.parse(data);
                            // Different proxy services have different JSON structures
                            data = json.contents || json.content || json.data || data;
                            if (typeof data !== 'string') {
                                data = JSON.stringify(data);
                            }
                            
                            // Check if the extracted data is also a data URL
                            if (data && typeof data === 'string' && data.startsWith('data:')) {
                                console.log('JSON content is a data URL, decoding...');
                                data = this.decodeDataUrl(data);
                            }
                        } catch (parseError) {
                            // If JSON parse fails, use the data as-is (might be plain text)
                            console.log('Proxy returned plain text, not JSON');
                        }
                    }
                    
                    // Validate we got actual data
                    if (!data || data.trim().length === 0) {
                        throw new Error('Proxy returned empty response');
                    }
                    
                    console.log('CORS proxy succeeded, received', data.length, 'bytes');
                    return data;
                    
                } catch (proxyError) {
                    console.warn('CORS proxy failed:', proxyError.message);
                    continue;
                }
            }
            
            throw new Error('All CORS proxies failed - none of the proxy services responded successfully');
        },

        async loadGames() {
            this.isLoading = true;
            this.errorMessage = '';
            
            try {
                let csvText;
                
                // Try Google Sheet first if configured
                if (USE_GOOGLE_SHEET) {
                    let googleSheetError = null;
                    
                    // Google Sheets always blocks direct browser access due to CORS
                    // So we'll use CORS proxy directly
                    const urlFormats = [
                        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`,
                        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&sheet=${encodeURIComponent(GOOGLE_SHEET_NAME)}`,
                        GOOGLE_SHEET_URL,
                        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`,
                    ];
                    
                    // Use CORS proxy for all Google Sheets requests
                    console.log('Fetching Google Sheet via CORS proxy (Google Sheets blocks direct browser access)...');
                    for (const url of urlFormats) {
                        try {
                            csvText = await this.fetchWithCorsProxy(url);
                            
                            // Check if we got valid CSV (not HTML error page)
                            if (csvText.trim().startsWith('<') || csvText.includes('<!DOCTYPE')) {
                                console.warn('Received HTML instead of CSV, trying next URL format...');
                                continue;
                            }
                            
                            // Check if CSV has content
                            if (csvText.trim().length === 0) {
                                console.warn('Sheet appears to be empty, trying next URL format...');
                                continue;
                            }
                            
                            // Validate CSV format (should have header row)
                            const firstLine = csvText.split('\n')[0];
                            if (!firstLine || firstLine.trim().length === 0) {
                                console.warn('Invalid CSV format, trying next URL format...');
                                continue;
                            }
                            
                            console.log('Successfully loaded from Google Sheet (via proxy)');
                            break; // Success, exit the loop
                            
                        } catch (proxyError) {
                            console.warn(`Proxy fetch failed for URL format: ${url}`, proxyError);
                            googleSheetError = proxyError;
                            continue; // Try next URL format
                        }
                    }
                    
                    // If all URL formats failed, try local fallback
                    if (!csvText) {
                        console.warn('All Google Sheet URL formats failed via proxy, trying local fallback');
                        try {
                            const response = await fetch('games.csv');
                            if (!response.ok) {
                                throw new Error(`Failed to load local CSV: ${response.status}`);
                            }
                            csvText = await response.text();
                            console.log('Loaded from local games.csv fallback');
                        } catch (localError) {
                            throw new Error(`Google Sheet failed: ${googleSheetError?.message || 'All CORS proxies failed'}. Local CSV also failed: ${localError.message}`);
                        }
                    }
                } else {
                    // Use local CSV file
                    const response = await fetch('games.csv');
                    if (!response.ok) {
                        throw new Error(`Failed to load games.csv: ${response.status} ${response.statusText}`);
                    }
                    csvText = await response.text();
                }
                
                this.parseCSV(csvText);
                this.filteredGames = [...this.games];
                this.updateStatistics();
                this.isLoading = false;
            } catch (error) {
                console.error('Error loading games:', error);
                this.errorMessage = `Failed to load games data: ${error.message}. Please check: 1) Sheet is shared publicly, 2) Sheet name is correct, 3) Your internet connection.`;
                // Fallback data in case all methods fail
                this.games = this.getFallbackGames();
                this.filteredGames = [...this.games];
                this.updateStatistics();
                this.isLoading = false;
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
                this.averagePrice = formatIDR(totalPrice / this.games.length);
                
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
    
    // Cart component for cart page
    Alpine.data('cartPage', () => ({
        cart: [],
        cartTotal: 0,
        cartCount: 0,
        
        init() {
            this.loadCart();
        },
        
        loadCart() {
            this.cart = CartManager.getCart();
            this.updateTotals();
        },
        
        updateTotals() {
            this.cartTotal = CartManager.getCartTotal();
            this.cartCount = CartManager.getCartCount();
        },
        
        updateQuantity(gameId, quantity) {
            this.cart = CartManager.updateQuantity(gameId, quantity);
            this.updateTotals();
        },
        
        removeFromCart(gameId) {
            this.cart = CartManager.removeFromCart(gameId);
            this.updateTotals();
        },
        
        clearCart() {
            this.cart = CartManager.clearCart();
            this.updateTotals();
            this.showNotification('Cart cleared');
        },
        
        showNotification(message) {
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
        },
        
        goToPayment() {
            if (this.cart.length === 0) return;
            window.location.href = 'payment.html';
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

// Initialize cart on page load
document.addEventListener('DOMContentLoaded', function() {
    // Update cart count in navigation if cart badge exists
    function updateCartBadge() {
        const badge = document.getElementById('cart-badge');
        if (badge) {
            const count = CartManager.getCartCount();
            badge.textContent = count;
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
    }
    
    updateCartBadge();
    
    // Listen for storage events (for cross-tab updates)
    window.addEventListener('storage', function(e) {
        if (e.key === 'gameStoreCart') {
            updateCartBadge();
        }
    });
    
    // Listen for cart update events (same tab)
    window.addEventListener('cartUpdated', function() {
        updateCartBadge();
    });
});
