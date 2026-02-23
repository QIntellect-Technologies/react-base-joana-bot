const menu = require('./menu');
const branchInfo = require('./branchInfo');
const translations = require('./translations');
const { advancedNLP, applyTypoCorrection } = require('./advancedNLP');
const { detectIntent } = require('./intentDetection');

const sessions = {};
const INITIAL_STATE = {
    step: 'INIT',
    language: null,
    currentCategory: null,
    currentItem: null,
    cart: [],
    itemOffset: 0,
    allCategoryItems: [],
    pendingIntents: [],
    currentIntent: null
};

function getSession(userId) {
    const now = Date.now();
    if (!sessions[userId]) {
        sessions[userId] = JSON.parse(JSON.stringify(INITIAL_STATE));
    }
    sessions[userId]._lastActive = now;
    return sessions[userId];
}

function resetSession(userId) {
    sessions[userId] = JSON.parse(JSON.stringify(INITIAL_STATE));
}

function getOrderSummaryText(cart, currentLang, t) {
    const grouped = {};
    cart.forEach(item => {
        const catId = item.catId || 'other';
        if (!grouped[catId]) {
            const category = menu.categories.find(c => c.id === catId);
            grouped[catId] = {
                title: category ? (currentLang === 'ar' ? category.title.ar : category.title.en) : (currentLang === 'ar' ? 'أصناف أخرى' : 'Other Items'),
                items: {}
            };
        }
        const key = item.id + (item.preference ? `_${item.preference}` : '');
        if (!grouped[catId].items[key]) grouped[catId].items[key] = { ...item, qty: 0 };
        grouped[catId].items[key].qty += 1;
    });

    let total = 0;
    let receiptText = `${t.order_summary}\n────────────────\n`;
    let globalIndex = 1;

    Object.keys(grouped).forEach(catId => {
        const group = grouped[catId];
        receiptText += `*📦 ${group.title}*\n`;
        Object.values(group.items).forEach((item) => {
            const lineTotal = item.price * item.qty;
            total += lineTotal;
            const prefLabel = item.preference === 'spicy' ? t.spicy : (item.preference === 'non-spicy' ? t.non_spicy : '');
            const prefStr = item.preference ? ` (${prefLabel})` : '';
            const name = currentLang === 'ar' ? item.name.ar : item.name.en;
            receiptText += `  ${globalIndex++}. ${name}${prefStr}\n  ${item.qty} x ${item.price} = ${lineTotal} SAR\n`;
        });
        receiptText += '\n';
    });
    receiptText += `────────────────\n*${t.total}: ${total} SAR*`;
    return receiptText;
}

function processSequentially(intents, currentCart, currentLang, state, messages = []) {
    const t = translations[currentLang || 'en'];
    if (intents.length === 0) {
        state.pendingIntents = [];
        state.currentIntent = null;
        // Mirroring frontend showOrderSummary behavior
        if (currentCart.length > 0) {
            state.currentItem = null; // SAFETY: Clear context so next command doesn't attach to last item
            const summary = getOrderSummaryText(currentCart, currentLang, t);
            messages.push(summary + `\n\n${t.order_completed}`);
            messages.push({
                type: 'button',
                body: t.add_more_prompt,
                buttons: [
                    { id: 'add_more', title: t.add_more },
                    { id: 'finish_order', title: t.finish_order }
                ]
            });
            state.step = 'SUMMARY_MENU'; // Mirroring frontend state
        }
        return messages;
    }

    const nextIntent = intents[0];
    const remaining = intents.slice(1);
    console.log(`[DEBUG] Processing intent: ${nextIntent.type} (Qty: ${nextIntent.qty}). Remaining: ${remaining.length}`);

    if (nextIntent.type === 'CATEGORY') {
        const categoryId = nextIntent.data.id;
        const items = menu.items[categoryId] || [];
        const allItems = items.map(item => ({ ...item, catId: categoryId }));
        const catTitle = currentLang === 'ar' ? nextIntent.data.title.ar : nextIntent.data.title.en;

        state.step = 'ITEMS_LIST';
        state.currentCategory = categoryId;
        state.itemOffset = 0;
        state.allCategoryItems = allItems;
        state.pendingIntents = remaining;
        state.currentIntent = nextIntent;

        const hasQty = !!nextIntent.qty;
        const qty = nextIntent.qty || 1;

        let prompt = hasQty ? (categoryId === 'wraps' ? t.nlp_qty_wraps.replace('{qty}', qty) : t.nlp_qty_category.replace('{name}', catTitle).replace('{qty}', qty))
            : (categoryId === 'wraps' ? t.nlp_browse_wraps : t.nlp_browse_category.replace('{name}', catTitle));

        messages.push(prompt);
        const itemsToShow = allItems.slice(0, 2);
        const buttons = itemsToShow.map(item => ({
            id: `item_${item.id}`,
            title: (currentLang === 'ar' ? item.name.ar : item.name.en).substring(0, 20)
        }));

        if (allItems.length > 2) buttons.push({ id: 'more_items', title: t.more });
        messages.push({ type: 'button', body: t.select_option, buttons });
        return messages;
    }

    if (nextIntent.type === 'UNKNOWN') {
        messages.push(currentLang === 'ar' ? `عذراً، "${nextIntent.data}" غير موجود في القائمة.` : `Sorry, "${nextIntent.data}" is not on our menu.`);

        // If this is the last intent and nothing was added, show the menu
        if (remaining.length === 0 && state.cart.length === 0) {
            messages.push(t.choose_category);
            messages.push({
                type: 'button',
                body: t.here_is_menu,
                buttons: [
                    { id: 'cat_burgers_meals', title: t.burgers_meals },
                    { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps },
                    { id: 'cat_snacks_sides', title: t.snacks_sides }
                ]
            });
            state.step = 'CATEGORY_SELECTION';
            // Clear items/context just in case
            state.currentItem = null;
        }

        return processSequentially(remaining, state.cart, currentLang, state, messages);
    }

    if (nextIntent.type === 'ITEM') {
        const item = nextIntent.data || state.currentItem;
        if (!item) return processSequentially(remaining, state.cart, currentLang, state, messages);

        const qty = nextIntent.qty || 1;
        const action = nextIntent.action || 'ADD';
        const preference = nextIntent.preference;
        const needsSpicy = item.catId === 'burgers' || item.id === '4'; // Extra check for Zinger Spicy
        const itemName = currentLang === 'ar' ? item.name.ar : item.name.en;

        if (action === 'REMOVE') {
            let removedCount = 0;
            for (let j = state.cart.length - 1; j >= 0; j--) {
                const cartItem = state.cart[j];
                if (cartItem.id === item.id && (!preference || cartItem.preference === preference)) {
                    state.cart.splice(j, 1);
                    removedCount++;
                    if (removedCount === qty) break;
                }
            }
            if (removedCount > 0) {
                messages.push(`${currentLang === 'ar' ? 'تم حذف' : 'Removed'} ${removedCount}x ${itemName}`);
            }
            return processSequentially(remaining, state.cart, currentLang, state, messages);
        }

        if (!needsSpicy || preference) {
            const itemWithPref = (preference && needsSpicy) ? { ...item, preference } : item;
            for (let i = 0; i < qty; i++) state.cart.push(itemWithPref);
            messages.push(`${t.added_to_cart} ${qty}x ${itemName}${preference ? ` (${preference === 'spicy' ? t.spicy : t.non_spicy})` : ''} ${t.to_your_cart}`);
            return processSequentially(remaining, state.cart, currentLang, state, messages);
        } else {
            state.step = 'ITEM_SPICY';
            state.currentItem = { ...item, qty };
            state.pendingIntents = remaining;
            state.currentIntent = nextIntent;
            messages.push({
                type: 'button',
                body: `${t.how_would_you_like} ${itemName}?`,
                buttons: [
                    { id: 'spicy_yes', title: t.spicy },
                    { id: 'spicy_no', title: t.non_spicy }
                ]
            });
            return messages;
        }
    }
    return messages;
}

function processMessage(userId, text) {
    const state = getSession(userId);
    let normalizedInput = text;
    const easternDigits = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
    easternDigits.forEach((regex, i) => normalizedInput = normalizedInput.replace(regex, i));

    // DYNAMIC LANGUAGE DETECTION: Check every message
    const isArabicInput = /[\u0600-\u06FF]/.test(text);
    if (isArabicInput) {
        state.language = 'ar';
    } else if (!state.language) {
        // Default to English if no language set and input is not Arabic
        state.language = 'en';
    }
    const currentLang = state.language;

    const t = translations[currentLang];
    const standardizedInput = applyTypoCorrection(normalizedInput, currentLang);
    let cleanText = standardizedInput.trim();

    // 1. INIT Logic (Prioritized to handle first message)
    if (state.step === 'INIT') {
        state.step = 'CATEGORY_SELECTION';
        // Language will be auto-detected by processMessage logic at top of function
        const welcomeMsg = t.welcome + branchInfo.branches.map((b, i) => `${i + 1}. ${currentLang === 'ar' ? (b.nameAr || b.name) : b.name}\n   ${b.phone}`).join('\n') + t.choose_option;
        return [{
            type: 'button',
            body: welcomeMsg,
            buttons: [
                { id: 'order_text', title: t.order_text },
                { id: 'order_voice', title: t.order_voice }
            ]
        }];
    }

    // 2. Button Handling (Strict IDs)
    if (cleanText === 'order_text' || cleanText === 'order_voice') {
        state.step = 'CATEGORY_SELECTION';
        return [
            t.choose_category,
            {
                type: 'button',
                body: t.here_is_menu,
                buttons: [
                    { id: 'cat_burgers_meals', title: t.burgers_meals },
                    { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps },
                    { id: 'cat_snacks_sides', title: t.snacks_sides }
                ]
            }
        ];
    }

    if (cleanText === 'cat_burgers_meals' || cleanText === 'cat_sandwiches_wraps' || cleanText === 'cat_snacks_sides') {
        let categoryIds = cleanText === 'cat_burgers_meals' ? ['burgers', 'meals'] : cleanText === 'cat_sandwiches_wraps' ? ['sandwiches', 'wraps'] : ['sides', 'drinks', 'juices'];
        let allItems = [];
        categoryIds.forEach(id => { (menu.items[id] || []).forEach(item => allItems.push({ ...item, catId: id })); });
        state.step = 'ITEMS_LIST';
        state.itemOffset = 0;
        state.allCategoryItems = allItems;
        const itemsToShow = allItems.slice(0, 2);
        const buttons = itemsToShow.map(item => ({
            id: `item_${item.id}`,
            title: (currentLang === 'ar' ? item.name.ar : item.name.en).substring(0, 20)
        }));

        if (allItems.length > 2) buttons.push({ id: 'more_items', title: t.more });
        return [{ type: 'button', body: t.select_option, buttons }];
    }

    if (cleanText === 'more_items') {
        state.itemOffset += 2;
        const itemsToShow = state.allCategoryItems.slice(state.itemOffset, state.itemOffset + 2);
        const buttons = itemsToShow.map(item => ({
            id: `item_${item.id}`,
            title: (currentLang === 'ar' ? item.name.ar : item.name.en).substring(0, 20)
        }));
        if (state.allCategoryItems.length > state.itemOffset + 2) buttons.push({ id: 'more_items', title: t.more });
        else buttons.push({ id: 'add_more', title: t.add_more });
        return [{ type: 'button', body: t.select_option, buttons }];
    }

    if (cleanText.startsWith('item_')) {
        const itemId = cleanText.replace('item_', '');
        const selectedItem = state.allCategoryItems.find(i => i.id === itemId);
        if (selectedItem) {
            state.currentItem = selectedItem;
            // Does it have a known qty from intents?
            if (state.currentIntent?.qty) {
                const qty = state.currentIntent.qty;
                if (selectedItem.catId === 'burgers') {
                    state.step = 'ITEM_SPICY';
                    state.currentItem.qty = qty;
                    return [{ type: 'button', body: `${t.how_would_you_like} ${currentLang === 'ar' ? selectedItem.name.ar : selectedItem.name.en}?`, buttons: [{ id: 'spicy_yes', title: t.spicy }, { id: 'spicy_no', title: t.non_spicy }] }];
                } else {
                    for (let i = 0; i < qty; i++) state.cart.push(selectedItem);
                    const msg = `${t.added_to_cart} ${qty}x ${currentLang === 'ar' ? selectedItem.name.ar : selectedItem.name.en} ${t.to_your_cart}`;
                    return processSequentially(state.pendingIntents, state.cart, currentLang, state, [msg]);
                }
            } else {
                state.step = 'ITEM_QTY';
                return [{ type: 'button', body: `${t.how_many} ${currentLang === 'ar' ? selectedItem.name.ar : selectedItem.name.en}?`, buttons: [{ id: 'qty_1', title: '1' }, { id: 'qty_2', title: '2' }, { id: 'qty_more', title: t.more }] }];
            }
        }
    }

    // 3. State-based Logic (Handles both Buttons and Text)
    if (state.step === 'ITEM_QTY' || state.step === 'ITEM_QTY_MANUAL') {
        const qty = parseInt(cleanText.replace('qty_', ''));
        if (cleanText === 'qty_more') { state.step = 'ITEM_QTY_MANUAL'; return [t.type_qty_manual]; }
        if (!isNaN(qty) && qty > 0) {
            if (state.currentItem.catId === 'burgers') {
                state.step = 'ITEM_SPICY';
                state.currentItem.qty = qty;
                return [{ type: 'button', body: `${t.how_would_you_like} ${currentLang === 'ar' ? state.currentItem.name.ar : state.currentItem.name.en}?`, buttons: [{ id: 'spicy_yes', title: t.spicy }, { id: 'spicy_no', title: t.non_spicy }] }];
            } else {
                for (let i = 0; i < qty; i++) state.cart.push(state.currentItem);
                const msg = `${t.added_to_cart} ${qty}x ${currentLang === 'ar' ? state.currentItem.name.ar : state.currentItem.name.en} ${t.to_your_cart}`;
                state.step = 'ITEMS_LIST';
                return processSequentially(state.pendingIntents, state.cart, currentLang, state, [msg]);
            }
        }
    }

    if (state.step === 'ITEM_SPICY') {
        // 1. Check for SPLIT preference (e.g. "1 spicy 1 regular")
        const spicyMatch = cleanText.match(/(\d+)\s+(spicy|hot)/i);
        const regularMatch = cleanText.match(/(\d+)\s+(non-spicy|non_spicy|regular|normal|ordinary|no spicy)/i);

        let spicyQty = spicyMatch ? parseInt(spicyMatch[1]) : 0;
        let regularQty = regularMatch ? parseInt(regularMatch[1]) : 0;

        // If simple "spicy" or "regular" without numbers, use total qty
        const totalQty = state.currentItem.qty || 1;

        if (cleanText === 'spicy_yes' || (!spicyMatch && (cleanText === 'spicy' || cleanText === 'hot'))) {
            spicyQty = totalQty;
        } else if (cleanText === 'spicy_no' || (!regularMatch && (cleanText === 'non-spicy' || cleanText === 'regular' || cleanText === 'normal' || cleanText === 'non_spicy'))) {
            regularQty = totalQty;
        }

        if (spicyQty > 0 || regularQty > 0) {
            // Add Spicy Items
            if (spicyQty > 0) {
                const itemSpicy = { ...state.currentItem, preference: 'spicy' };
                for (let i = 0; i < spicyQty; i++) state.cart.push(itemSpicy);
            }
            // Add Regular Items
            if (regularQty > 0) {
                const itemRegular = { ...state.currentItem, preference: 'non-spicy' };
                for (let i = 0; i < regularQty; i++) state.cart.push(itemRegular);
            }

            const spicyStr = spicyQty > 0 ? `${spicyQty}x ${t.spicy}` : '';
            const regularStr = regularQty > 0 ? `${regularQty}x ${t.non_spicy}` : '';
            const summaryStr = [spicyStr, regularStr].filter(Boolean).join(` ${t.and} `);
            const totalAdded = spicyQty + regularQty;

            const msg = `${t.added_to_cart} ${totalAdded}x ${currentLang === 'ar' ? state.currentItem.name.ar : state.currentItem.name.en} (${summaryStr}) ${t.to_your_cart}`;
            state.step = 'ITEMS_LIST';
            return processSequentially(state.pendingIntents, state.cart, currentLang, state, [msg]);
        }
    }

    if (cleanText === 'add_more') {
        state.step = 'CATEGORY_SELECTION';
        state.currentItem = null; // Clear context
        return [t.choose_category, { type: 'button', body: t.here_is_menu, buttons: [{ id: 'cat_burgers_meals', title: t.burgers_meals }, { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps }, { id: 'cat_snacks_sides', title: t.snacks_sides }] }];
    }

    if (cleanText === 'cancel_go_back') {
        state.step = 'CATEGORY_SELECTION';
        return [t.choose_category, { type: 'button', body: t.here_is_menu, buttons: [{ id: 'cat_burgers_meals', title: t.burgers_meals }, { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps }, { id: 'cat_snacks_sides', title: t.snacks_sides }] }];
    }

    if (cleanText === 'cancel_all') {
        resetSession(userId);
        return [t.cancel_success, { type: 'button', body: t.new_order_prompt, buttons: [{ id: 'new_order', title: t.new_order }] }];
    }

    if (cleanText === 'new_order') {
        state.step = 'CATEGORY_SELECTION';
        return [t.choose_category, { type: 'button', body: t.here_is_menu, buttons: [{ id: 'cat_burgers_meals', title: t.burgers_meals }, { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps }, { id: 'cat_snacks_sides', title: t.snacks_sides }] }];
    }

    if (cleanText === 'cancel_item') {
        if (state.cart.length === 0) return [t.cart_empty];

        // Group items for removal menu (Mirroring frontend logic)
        const groupedForRemoval = [];
        state.cart.forEach(item => {
            const key = item.id + (item.preference ? `_${item.preference}` : '');
            const existing = groupedForRemoval.find(g => g.key === key);
            if (existing) {
                existing.qty += 1;
            } else {
                groupedForRemoval.push({ key, ...item, qty: 1 });
            }
        });

        state.step = 'REMOVE_ITEM';
        state.removeOffset = 0;
        state.groupedRemovalItems = groupedForRemoval;

        const itemsToShow = groupedForRemoval.slice(0, 2);
        const buttons = itemsToShow.map(item => {
            const name = currentLang === 'ar' ? item.name.ar : item.name.en;
            const prefStr = item.preference ? ` (${item.preference === 'spicy' ? t.spicy : t.non_spicy})` : '';
            return { id: `remove_item_group_${item.key}`, title: `${t.remove} ${name}${prefStr}`.substring(0, 20) };
        });

        if (groupedForRemoval.length > 2) buttons.push({ id: 'remove_more', title: t.more });
        buttons.push({ id: 'cancel_go_back', title: t.go_back });

        return [t.select_remove, { type: 'button', body: t.select_option, buttons }];
    }

    // Handle Removal Selections
    if (state.step === 'REMOVE_ITEM' || cleanText.startsWith('remove_item_group_')) {
        if (cleanText === 'remove_more') {
            state.removeOffset = (state.removeOffset || 0) + 2;
            const itemsToShow = state.groupedRemovalItems.slice(state.removeOffset, state.removeOffset + 2);
            const buttons = itemsToShow.map(item => {
                const name = currentLang === 'ar' ? item.name.ar : item.name.en;
                const prefStr = item.preference ? ` (${item.preference === 'spicy' ? t.spicy : t.non_spicy})` : '';
                return { id: `remove_item_group_${item.key}`, title: `${t.remove} ${name}${prefStr}`.substring(0, 20) };
            });
            if (state.groupedRemovalItems.length > state.removeOffset + 2) buttons.push({ id: 'remove_more', title: t.more });
            else buttons.push({ id: 'cancel_go_back', title: t.go_back });
            return [{ type: 'button', body: t.select_option, buttons }];
        }

        if (cleanText.startsWith('remove_item_group_')) {
            const key = cleanText.replace('remove_item_group_', '');
            const selectedGroup = state.groupedRemovalItems.find(g => g.key === key);

            if (selectedGroup) {
                state.step = 'ITEM_REMOVE_QTY';
                state.currentItemToRemove = selectedGroup;

                const buttons = [];
                // WhatsApp max 3 buttons
                if (selectedGroup.qty <= 3) {
                    for (let i = 1; i <= selectedGroup.qty; i++) buttons.push({ id: `qty_remove_${i}`, title: `${i}` });
                } else {
                    buttons.push({ id: `qty_remove_1`, title: '1' });
                    buttons.push({ id: `qty_remove_2`, title: '2' });
                    buttons.push({ id: `qty_remove_all`, title: currentLang === 'ar' ? 'الكل' : 'All' });
                }

                const name = currentLang === 'ar' ? selectedGroup.name.ar : selectedGroup.name.en;
                return [{ type: 'button', body: `${t.remove_qty_ask} ${name} (${selectedGroup.qty})`, buttons }];
            }
        }
    }

    if (state.step === 'ITEM_REMOVE_QTY' && cleanText.startsWith('qty_remove_')) {
        let qtyToRemove = 0;
        if (cleanText === 'qty_remove_all') {
            qtyToRemove = state.currentItemToRemove.qty;
        } else {
            qtyToRemove = parseInt(cleanText.replace('qty_remove_', ''));
        }

        let removedCount = 0;
        for (let j = state.cart.length - 1; j >= 0; j--) {
            const item = state.cart[j];
            const key = item.id + (item.preference ? `_${item.preference}` : '');
            if (key === state.currentItemToRemove.key) {
                state.cart.splice(j, 1);
                removedCount++;
                if (removedCount === qtyToRemove) break;
            }
        }

        const name = currentLang === 'ar' ? state.currentItemToRemove.name.ar : state.currentItemToRemove.name.en;
        const msg = `${t.removed} ${removedCount}x ${name}`;
        state.step = 'CATEGORY_SELECTION';
        // Show summary and return to main menu or add more
        const summary = getOrderSummaryText(state.cart, currentLang, t);
        const combinedMsg = `${msg}\n\n${summary}\n\n${t.add_more_prompt}`;
        return [{ type: 'button', body: combinedMsg, buttons: [{ id: 'add_more', title: t.add_more }, { id: 'finish_order', title: t.finish_order }] }];
    }

    if (cleanText === 'finish_order') {
        if (state.cart.length === 0) return [t.cart_empty];
        const summary = getOrderSummaryText(state.cart, currentLang, t);
        state.step = 'PAYMENT';
        return [summary, { type: 'button', body: t.choose_payment, buttons: [{ id: 'pay_cash', title: t.cash }, { id: 'pay_online', title: t.online }, { id: 'cancel_order', title: t.cancel_order }] }];
    }

    if (state.step === 'PAYMENT' || cleanText === 'pay_cash' || cleanText === 'pay_online') {
        if (cleanText === 'pay_cash' || cleanText === 'pay_online') {
            const paymentMethod = cleanText === 'pay_cash' ? t.cash_on_delivery : t.online;
            let paymentDetails = `\n${t.payment_method}: ${paymentMethod}`;

            if (cleanText === 'pay_online') {
                const total = state.cart.reduce((sum, item) => sum + item.price, 0);
                const paymentLink = `https://joana-fastfood.com/pay?amount=${total}&ref=${userId}`;
                paymentDetails += `\n\nPayment Link: ${paymentLink}`;
            }

            const summary = getOrderSummaryText(state.cart, currentLang, t);
            const finalMsg = `${t.order_confirmed}\n${summary}${paymentDetails}\n\n${t.thank_you}`;

            resetSession(userId);
            return [finalMsg, { type: 'button', body: t.new_order_prompt, buttons: [{ id: 'new_order', title: t.new_order }] }];
        }
    }

    // 4. NLP & Intent Fallback
    // 4. NLP & Intent Fallback
    // 4. NLP & Intent Fallback
    // Check for Meta Commands (Typo Corrected) - Bypasses intent detection for robustness
    if (cleanText.includes('finish_order')) {
        cleanText = 'finish_order';
    } else if (cleanText.includes('cancel_order')) {
        cleanText = 'cancel_order';
        state.step = 'CANCEL_MENU';
        return [{
            type: 'button',
            body: t.cancel_menu,
            buttons: [
                { id: 'cancel_all', title: t.cancel_all },
                { id: 'cancel_item', title: t.cancel_item },
                { id: 'cancel_go_back', title: t.go_back }
            ]
        }];
    } else if (cleanText.includes('cancel_all')) {
        cleanText = 'cancel_all';
    }

    // Check again after forcing
    if (cleanText === 'finish_order') {
        if (state.cart.length === 0) return [t.cart_empty];
        const summary = getOrderSummaryText(state.cart, currentLang, t);
        state.step = 'PAYMENT';
        return [summary, { type: 'button', body: t.choose_payment, buttons: [{ id: 'pay_cash', title: t.cash }, { id: 'pay_online', title: t.online }, { id: 'cancel_order', title: t.cancel_order }] }];
    }

    const nlpIntents = advancedNLP(standardizedInput, currentLang);
    if (nlpIntents.length > 0) {
        // CRITICAL FIX: Merge new intents with any pending intents from previous steps (e.g., "5 drinks" -> prompt -> "water" -> resume "23 wraps")
        const combinedIntents = [...nlpIntents, ...state.pendingIntents];
        // Clear pending intents from state as they are now being actively processed/re-queued
        state.pendingIntents = [];
        return processSequentially(combinedIntents, state.cart, currentLang, state);
    }

    const explicitIntent = detectIntent(standardizedInput, currentLang);
    if (explicitIntent) {
        if (explicitIntent.intent === 'CANCEL_ORDER') {
            state.step = 'CANCEL_MENU';
            return [{
                type: 'button',
                body: t.cancel_menu,
                buttons: [
                    { id: 'cancel_all', title: t.cancel_all },
                    { id: 'cancel_item', title: t.cancel_item },
                    { id: 'cancel_go_back', title: t.go_back }
                ]
            }];
        }
        if (explicitIntent.intent === 'FINISH_ORDER') {
            // Fallthrough to standard text handler for FINISH_ORDER to ensure consistent Payment Flow
            cleanText = 'finish_order';
        }
        if (explicitIntent.intent === 'BROWSE_ALL_CATEGORIES') {
            state.step = 'CATEGORY_SELECTION';
            const menuImage = process.env.MENU_IMAGE_URL;
            const replies = [];
            if (menuImage) {
                replies.push({ type: 'image', link: menuImage });
            }
            replies.push(t.here_is_menu);
            replies.push({
                type: 'button',
                body: t.select_option,
                buttons: [
                    { id: 'cat_burgers_meals', title: t.burgers_meals },
                    { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps },
                    { id: 'cat_snacks_sides', title: t.snacks_sides }
                ]
            });
            return replies;
        }
        if (explicitIntent.intent === 'BROWSE_CATEGORY') { return processSequentially([{ type: 'CATEGORY', data: { id: explicitIntent.categoryId, title: menu.categories.find(c => c.id === explicitIntent.categoryId).title } }], state.cart, currentLang, state); }
        if (explicitIntent.intent === 'IRRELEVANT') {
            state.step = 'CATEGORY_SELECTION';
            return [
                t.irrelevant_message,
                {
                    type: 'button',
                    body: t.here_is_menu,
                    buttons: [
                        { id: 'cat_burgers_meals', title: t.burgers_meals },
                        { id: 'cat_sandwiches_wraps', title: t.sandwiches_wraps },
                        { id: 'cat_snacks_sides', title: t.snacks_sides }
                    ]
                }
            ];
        }
    }

    return [t.didnt_understand + ' ' + t.use_buttons];
}

module.exports = {
    processMessage,
    getSession,
    resetSession
};
