(() => {
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

    window.CartManager = CartManager;

    const updateCartBadge = () => {
        const badge = document.getElementById('cart-badge');
        if (!badge) {
            return;
        }

        const count = CartManager.getCartCount();
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline' : 'none';
    };

    document.addEventListener('DOMContentLoaded', () => {
        updateCartBadge();
    });

    window.addEventListener('storage', (event) => {
        if (event.key === 'gameStoreCart') {
            updateCartBadge();
        }
    });

    window.addEventListener('cartUpdated', () => {
        updateCartBadge();
    });

    document.addEventListener('alpine:init', () => {
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
})();

