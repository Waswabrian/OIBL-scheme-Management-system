const express = require('express');
const router = express.Router();
const db = require('../config/db');


router.get('/new', async (req, res) => {

    const [schemes] = await db.query(`
        SELECT
            scheme_id,
            scheme_name,
            company_name
        FROM schemes
        ORDER BY scheme_name
    `);

    res.render('claims/create', {
        schemes,
        user: req.session.user
    });
});





router.get('/', async (req, res) => {

    const [claims] = await db.query(`
       SELECT
    c.*,
    s.scheme_name,
    s.company_name,
    st.full_name AS officer
    FROM claims c
    INNER JOIN schemes s
        ON s.scheme_id = c.scheme_id
    LEFT JOIN staff st
        ON st.staff_id = c.assigned_officer
    ORDER BY c.created_at DESC
    `);

    res.render('claims/index', {
        claims,
        schemes: (await db.query('SELECT * FROM schemes ORDER BY scheme_id'))[0],
        user: req.session.user
    });
});

router.get('/new', async (req, res) => {
    await recordActivity({
    userId: req.session.user.id,
    userName: req.session.user.full_name,
    title: "Claim Submitted",
    detail: `Claim ${claimNumber} submitted for ${client_name}.`
});
    await recordActivity({
    userId: req.session.user.id,
    userName: req.session.user.full_name,
    title: "Claim Status Updated",
    detail: `Claim ${req.params.id} changed to ${req.body.status}.`
});

    res.render('claims/create', {
        user: req.session.user
    });
});

router.post('/new', async (req, res) => {

    const {
        client_name,
        policy_number,
        claim_type,
        date_of_loss,
        description
    } = req.body;

    const claimNumber =
        'CLM-' + Date.now();

    await db.query(
        `
        INSERT INTO claims (
            claim_number,
            client_name,
            policy_number,
            claim_type,
            date_of_loss,
            description,
            created_by
        )
        VALUES (?,?,?,?,?,?,?)
        `,
        [
            claimNumber,
            client_name,
            policy_number,
            claim_type,
            date_of_loss,
            description,
            req.session.user.id
        ]
    );

    res.redirect('/claims');
});

router.get('/:id', async (req, res) => {

    const [claims] = await db.query(
        `
        SELECT
            c.*,
            s.scheme_name,
            s.company_name,
            s.insurer,
            s.policy_type
        FROM claims c
        INNER JOIN schemes s
            ON c.scheme_id = s.scheme_id
        WHERE c.claim_id = ?
        ORDER BY c.created_at DESC;
        `,
        [req.params.id]
    );

    if (!claims.length) {
        return res.send('Claim not found');
    }

    res.render('claims/show', {
        claim: claims[0],
        user: req.session.user,
        schemes: (await db.query('SELECT * FROM schemes ORDER BY scheme_id'))[0]
    });
});

router.post('/:id/status', async (req, res) => {

    await db.query(
        `
        UPDATE claims
        SET status = ?
        WHERE claim_id = ?
        `,
        [
            req.body.status,
            req.params.id
        ]
    );

    res.redirect(`/claims/${req.params.id}`);
});

module.exports = router;