(() => {
    const formatIDR = (amount) => {
        const roundedAmount = Math.round(amount);
        return 'Rp ' + roundedAmount.toLocaleString('id-ID');
    };

    const setCache = (key, value) => {
        localStorage.setItem(key, JSON.stringify(value));
    };

    const getCache = (key) => {
        return JSON.parse(localStorage.getItem(key));
    };

    window.formatIDR = formatIDR;
    window.setCache = setCache;
    window.getCache = getCache;
})();
