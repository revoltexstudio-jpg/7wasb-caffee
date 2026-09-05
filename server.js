const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./cafe.db', (err) => {
    if (err) console.error('خطأ في الاتصال بقاعدة البيانات:', err);
    else console.log('تم الاتصال بقاعدة البيانات بنجاح.');
});

// إنشاء الجداول
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        pin TEXT,
        role TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        category TEXT,
        cost_price REAL,
        selling_price REAL,
        stock_quantity INTEGER DEFAULT 0,
        is_drink INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS product_ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_product_id INTEGER,
        ingredient_id INTEGER,
        quantity_required REAL,
        FOREIGN KEY(parent_product_id) REFERENCES products(id),
        FOREIGN KEY(ingredient_id) REFERENCES products(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        variant_name TEXT,
        price_modifier REAL DEFAULT 0,
        cost_modifier REAL DEFAULT 0,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        start_time DATETIME,
        end_time DATETIME,
        status TEXT,
        shift_date TEXT,
        notes TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        unit_price REAL,
        unit_cost REAL,
        is_staff_order INTEGER DEFAULT 0,
        tip_amount REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`INSERT OR IGNORE INTO users (id, username, pin, role) VALUES 
        (1, 'admin', '1234', 'admin'),
        (2, 'cashier', '1111', 'cashier')`);
});

// 1. تسجيل الدخول
app.post('/api/login', (req, res) => {
    const { username, pin } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND pin = ?`, [username, pin], (err, user) => {
        if (err || !user) return res.status(401).json({ message: 'بيانات غير صحيحة' });

        if (user.role === 'cashier') {
            db.get(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open'`, [user.id], (err, activeShift) => {
                res.json({ user, activeShift: activeShift || null });
            });
        } else {
            res.json({ user, activeShift: null });
        }
    });
});

// 2. بدء شيفت جديد
app.post('/api/start-shift', (req, res) => {
    const { user_id } = req.body;
    const now = new Date();
    const shiftDate = now.toISOString().split('T')[0];

    db.run(`INSERT INTO shifts (user_id, start_time, status, shift_date) VALUES (?, datetime('now', 'localtime'), 'open', ?)`,
        [user_id, shiftDate], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ shift_id: this.lastID });
        });
});

// 3. جلب الأصناف
app.get('/api/products', (req, res) => {
    db.all(`SELECT * FROM products`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 4. حفظ أو تعديل صنف
app.post('/api/products', (req, res) => {
    const { id, name, category, cost_price, selling_price, stock_quantity, is_drink } = req.body;

    if (id) {
        db.run(`UPDATE products SET name=?, category=?, cost_price=?, selling_price=?, stock_quantity=?, is_drink=? WHERE id=?`,
            [name, category, cost_price, selling_price, stock_quantity, is_drink ? 1 : 0, id], err => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'تم التحديث' });
            });
    } else {
        db.run(`INSERT INTO products (name, category, cost_price, selling_price, stock_quantity, is_drink) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, category, cost_price, selling_price, stock_quantity, is_drink ? 1 : 0], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID });
            });
    }
});

// 5. حذف صنف
app.delete('/api/products/:id', (req, res) => {
    const productId = req.params.id;
    db.run(`DELETE FROM product_ingredients WHERE parent_product_id = ? OR ingredient_id = ?`, [productId, productId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM product_variants WHERE product_id = ?`, [productId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`DELETE FROM products WHERE id = ?`, [productId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'تم حذف المنتج بنجاح' });
            });
        });
    });
});

// 6. ربط المكونات
app.post('/api/product-ingredients', (req, res) => {
    const { parent_product_id, ingredients } = req.body;
    db.run(`DELETE FROM product_ingredients WHERE parent_product_id = ?`, [parent_product_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        const stmt = db.prepare(`INSERT INTO product_ingredients (parent_product_id, ingredient_id, quantity_required) VALUES (?, ?, ?)`);
        ingredients.forEach(item => {
            stmt.run(parent_product_id, item.ingredient_id, item.quantity_required);
        });
        stmt.finalize();
        res.json({ message: 'تم ربط المكونات بنجاح' });
    });
});

app.get('/api/product-ingredients/:id', (req, res) => {
    db.all(`SELECT pi.*, p.name FROM product_ingredients pi JOIN products p ON pi.ingredient_id = p.id WHERE pi.parent_product_id = ?`, 
    [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 7. الأحجام والخيارات
app.post('/api/product-variants', (req, res) => {
    const { product_id, variants } = req.body;
    db.run(`DELETE FROM product_variants WHERE product_id = ?`, [product_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        const stmt = db.prepare(`INSERT INTO product_variants (product_id, variant_name, price_modifier, cost_modifier) VALUES (?, ?, ?, ?)`);
        variants.forEach(v => {
            stmt.run(product_id, v.variant_name, v.price_modifier, v.cost_modifier);
        });
        stmt.finalize();
        res.json({ message: 'تم حفظ الخيارات بنجاح' });
    });
});

app.get('/api/product-variants/:id', (req, res) => {
    db.all(`SELECT * FROM product_variants WHERE product_id = ?`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 8. إتمام البيع
app.post('/api/checkout', (req, res) => {
    const { shift_id, cart, is_staff_order, paid_amount } = req.body;

    let totalCartPrice = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let calculatedTip = (paid_amount > totalCartPrice && totalCartPrice > 0) ? (paid_amount - totalCartPrice) : 0;

    db.serialize(() => {
        cart.forEach(item => {
            let finalPrice = is_staff_order ? item.cost : item.price;

            db.run(`INSERT INTO sales (shift_id, product_id, quantity, unit_price, unit_cost, is_staff_order, tip_amount) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [shift_id, item.id, item.qty, finalPrice, item.cost, is_staff_order ? 1 : 0, calculatedTip]);

            db.all(`SELECT * FROM product_ingredients WHERE parent_product_id = ?`, [item.id], (err, ingredients) => {
                if (!err && ingredients && ingredients.length > 0) {
                    ingredients.forEach(ing => {
                        db.run(`UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND is_drink = 0`, 
                            [ing.quantity_required * item.qty, ing.ingredient_id]);
                    });
                } else {
                    db.run(`UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND is_drink = 0`, 
                        [item.qty, item.id]);
                }
            });
            calculatedTip = 0;
        });
        res.json({ success: true, tip: paid_amount > totalCartPrice ? paid_amount - totalCartPrice : 0 });
    });
});

// 9. ملخص الشيفت المباشر
app.get('/api/shift-summary/:shift_id', (req, res) => {
    const shiftId = req.params.shift_id;
    db.get(`
        SELECT 
            COALESCE(SUM(quantity * unit_price), 0) as total_sales,
            COALESCE(SUM(quantity * (unit_price - unit_cost)), 0) as total_profit,
            COALESCE(SUM(tip_amount), 0) as total_tips
        FROM sales WHERE shift_id = ?
    `, [shiftId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// 10. إغلاق الشيفت
app.post('/api/end-shift', (req, res) => {
    const { shift_id, notes } = req.body;
    db.run(`UPDATE shifts SET end_time = datetime('now', 'localtime'), status = 'closed', notes = ? WHERE id = ?`,
        [notes, shift_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'تم إغلاق الشيفت' });
        });
});

// 11. تفاصيل مبيعات الشيفت
app.get('/api/admin/shift-live-details/:shift_id', (req, res) => {
    db.all(`
        SELECT p.name, p.category, s.quantity, s.unit_price, (s.quantity * s.unit_price) as subtotal, s.created_at 
        FROM sales s 
        JOIN products p ON s.product_id = p.id 
        WHERE s.shift_id = ? ORDER BY s.created_at DESC
    `, [req.params.shift_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 12. لوحة الأدمن
app.get('/api/admin/dashboard', (req, res) => {
    db.all(`
        SELECT 
            s.id, s.start_time, s.end_time, s.status, s.shift_date, s.notes, u.username,
            COALESCE(SUM(sa.quantity * sa.unit_price), 0) as total_sales,
            COALESCE(SUM(sa.quantity * (sa.unit_price - sa.unit_cost)), 0) as total_profit,
            COALESCE(SUM(sa.tip_amount), 0) as total_tips
        FROM shifts s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN sales sa ON s.id = sa.shift_id
        GROUP BY s.id ORDER BY s.id DESC
    `, [], (err, shifts) => {
        db.get(`
            SELECT 
                COALESCE(SUM(quantity * unit_cost), 0) as collected_stock_cost 
            FROM sales
        `, [], (err, stockCollected) => {
            db.get(`
                SELECT 
                    COALESCE(SUM(stock_quantity * cost_price), 0) as remaining_stock_cost 
                FROM products WHERE is_drink = 0
            `, [], (err, stockRemaining) => {
                db.all(`SELECT * FROM products`, [], (err, products) => {
                    res.json({
                        shifts,
                        stats: {
                            collected_stock_cost: stockCollected ? stockCollected.collected_stock_cost : 0,
                            remaining_stock_cost: stockRemaining ? stockRemaining.remaining_stock_cost : 0
                        },
                        products
                    });
                });
            });
        });
    });
});

app.post('/api/admin/force-close-shift', (req, res) => {
    db.run(`UPDATE shifts SET end_time = datetime('now', 'localtime'), status = 'closed', notes = 'إغلاق إجباري بواسطة المسؤول' WHERE id = ?`,
        [req.body.shift_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'تم الإغلاق' });
        });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 شغال على البورت ${PORT} - حواسب كافيه ❤️`));
