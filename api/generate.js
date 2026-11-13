"use strict";

/*
=========================================================
INDORILA EBOOK AI
Backend API
File: api/generate.js

Frontend endpoint: /api/generate

AI: Pollinations.ai
Text model: DeepSeek V4 Flash through Pollinations
Image model: Flux Schnell through Pollinations
Payment: Paymegate
Database: None

Actions:
1. generate
2. create_payment
3. verify_payment

=========================================================
*/

const crypto = require("crypto");

const CONFIG = {
    POLLINATIONS_URL: "https://gen.pollinations.ai",
    PAYMEGATE_URL: "https://api.paymegate.com",

    TEXT_MODEL: "deepseek/deepseek-v4-flash",

    IMAGE_MODEL: "black-forest-labs/flux.1-schnell",

    PRICE: "6.00",

    CURRENCY: "USD",

    MAX_CHAPTERS: 30,

    MAX_PROMPT_LENGTH: 12000,

    REQUEST_TIMEOUT: 240000
};


/* =====================================================
   RESPONSE HELPERS
===================================================== */

function send(res, status, data) {

    res.statusCode = status;

    res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
    );

    res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
    );

    res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
    );

    return res.end(JSON.stringify(data));

}


function error(message, status = 400) {

    const err = new Error(message);

    err.statusCode = status;

    return err;

}


function getBody(req) {

    if (req.body && typeof req.body === "object") {

        return req.body;

    }

    if (typeof req.body === "string") {

        try {

            return JSON.parse(req.body);

        } catch {

            throw error("Invalid JSON request.");

        }

    }

    return {};

}


/* =====================================================
   ENVIRONMENT CONFIGURATION
===================================================== */

function getPollinationsKey() {

    const key = process.env.POLLINATIONS_API_KEY;

    if (!key) {

        throw error(
            "Pollinations API key is not configured.",
            503
        );

    }

    if (!key.startsWith("sk_")) {

        throw error(
            "Invalid Pollinations secret key configuration.",
            503
        );

    }

    return key;

}


function getPaymegateKey() {

    const key = process.env.PAYMEGATE_API_KEY;

    if (!key) {

        throw error(
            "Paymegate API key is not configured.",
            503
        );

    }

    return key;

}


function getSiteURL() {

    const value = process.env.SITE_URL;

    if (!value) {

        throw error(
            "SITE_URL must be configured before creating payments.",
            503
        );

    }

    let parsed;

    try {

        parsed = new URL(value);

    } catch {

        throw error("Invalid SITE_URL configuration.", 503);

    }

    if (parsed.protocol !== "https:") {

        throw error(
            "SITE_URL must use HTTPS.",
            503
        );

    }

    return parsed.origin;

}


/* =====================================================
   FETCH WITH TIMEOUT
===================================================== */

async function secureFetch(url, options = {}, timeout = 60000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        return await fetch(url, {

            ...options,

            signal: controller.signal

        });

    } catch (err) {

        if (err.name === "AbortError") {

            throw error(
                "The external service took too long to respond.",
                504
            );

        }

        throw err;

    } finally {

        clearTimeout(timer);

    }

}


/* =====================================================
   SAFE RESPONSE PARSING
===================================================== */

async function readJSON(response) {

    const text = await response.text();

    let data;

    try {

        data = JSON.parse(text);

    } catch {

        throw error(
            "The external service returned an invalid response.",
            502
        );

    }

    if (!response.ok) {

        const message =
            data.error?.message ||
            data.message ||
            "External service request failed.";

        throw error(message, 502);

    }

    return data;

}


/* =====================================================
   TEXT GENERATION
===================================================== */

async function generateText(prompt) {

    const key = getPollinationsKey();

    const response = await secureFetch(

        CONFIG.POLLINATIONS_URL +
        "/v1/chat/completions",

        {

            method: "POST",

            headers: {

                "Authorization": "Bearer " + key,

                "Content-Type": "application/json",

                "Pollinations-Safe":
                    "privacy,secrets,sexual,violence,shield"

            },

            body: JSON.stringify({

                model: CONFIG.TEXT_MODEL,

                messages: [

                    {

                        role: "system",

                        content: `
You are the professional ebook-writing engine
for Indorila ebook AI.

YOUR MAIN RESPONSIBILITY:

Transform even extremely short user descriptions
into substantial, professionally written ebooks.

WRITING REQUIREMENTS:

1. Understand the user's intended topic.
2. Expand small ideas into comprehensive books.
3. Never produce shallow or unnecessarily short chapters.
4. Automatically determine the ideal number of chapters.
5. Never exceed 30 chapters.
6. Do not ask users to select chapter counts.
7. Each chapter must contain detailed explanations,
   practical examples, and useful insights where relevant.
8. Create a logical sequence between chapters.
9. Write a substantial introduction.
10. Write a meaningful conclusion.
11. Use professional book-writing language.
12. Use Markdown bold formatting for important terms,
    headings, key statements and important concepts.
13. Avoid repeating the same explanations.
14. Maintain consistency throughout the book.
15. Do not invent factual claims or citations.
16. Do not include filler content merely to increase length.

CHAPTER REQUIREMENTS:

Choose the chapter count yourself.

Use fewer chapters for narrow topics and more chapters
for broad topics.

The absolute maximum is 30 chapters.

Aim for approximately 500-700 words per chapter
where the topic and output capacity allow.

BOOK STRUCTURE:

- Professional title.
- Introduction.
- Chapters.
- Conclusion.
- Cover image description.

OUTPUT REQUIREMENTS:

Return ONLY valid JSON.

Use this exact structure:

{
  "title": "Book title",
  "introduction": "Detailed introduction",
  "chapters": [
    {
      "title": "Chapter title",
      "content": "Detailed chapter content using **bold** formatting"
    }
  ],
  "conclusion": "Detailed conclusion",
  "cover_prompt": "Detailed professional square ebook cover description"
}

Do not include Markdown code fences around the JSON.

Never return more than 30 chapters.
                        `

                    },

                    {

                        role: "user",

                        content: prompt

                    }

                ],

                temperature: 0.75,

                max_tokens: 24000,

                response_format: {

                    type: "json_object"

                },

                stream: false

            })

        },

        CONFIG.REQUEST_TIMEOUT

    );

    return await readJSON(response);

}


/* =====================================================
   JSON EXTRACTION
===================================================== */

function extractJSON(data) {

    let content =
        data?.choices?.[0]?.message?.content;

    if (Array.isArray(content)) {

        content = content

            .map(item => item.text || "")

            .join("");

    }

    if (typeof content !== "string" || !content.trim()) {

        throw error(
            "The AI did not return ebook content.",
            502
        );

    }

    content = content.trim();

    content = content.replace(
        /^```(?:json)?\s*/i,
        ""
    );

    content = content.replace(
        /\s*```$/,
        ""
    );

    let parsed;

    try {

        parsed = JSON.parse(content);

    } catch {

        const first = content.indexOf("{");

        const last = content.lastIndexOf("}");

        if (first < 0 || last <= first) {

            throw error(
                "The AI returned incomplete ebook data.",
                502
            );

        }

        try {

            parsed = JSON.parse(
                content.substring(first, last + 1)
            );

        } catch {

            throw error(
                "The generated ebook could not be parsed.",
                502
            );

        }

    }

    return parsed;

}


/* =====================================================
   EBOOK VALIDATION
===================================================== */

function validateBook(book) {

    if (!book || typeof book !== "object") {

        throw error("Invalid ebook response.", 502);

    }

    if (
        typeof book.title !== "string" ||
        !book.title.trim()
    ) {

        throw error("The ebook title is missing.", 502);

    }

    if (
        !Array.isArray(book.chapters) ||
        book.chapters.length < 1 ||
        book.chapters.length > CONFIG.MAX_CHAPTERS
    ) {

        throw error(
            "The generated ebook has an invalid chapter structure.",
            502
        );

    }

    if (
        typeof book.introduction !== "string" ||
        !book.introduction.trim()
    ) {

        throw error(
            "The ebook introduction is incomplete.",
            502
        );

    }

    if (
        typeof book.conclusion !== "string" ||
        !book.conclusion.trim()
    ) {

        throw error(
            "The ebook conclusion is incomplete.",
            502
        );

    }

    for (let i = 0; i < book.chapters.length; i++) {

        const chapter = book.chapters[i];

        if (
            !chapter ||
            typeof chapter.title !== "string" ||
            !chapter.title.trim() ||
            typeof chapter.content !== "string" ||
            !chapter.content.trim()
        ) {

            throw error(
                "Chapter " + (i + 1) + " is incomplete.",
                502
            );

        }

    }

    return {

        title: book.title.trim(),

        introduction: book.introduction,

        chapters: book.chapters,

        conclusion: book.conclusion,

        cover_prompt:
            typeof book.cover_prompt === "string"
                ? book.cover_prompt
                : ""

    };

}


/* =====================================================
   AI COVER GENERATION
===================================================== */

async function generateCover(book) {

    const key = getPollinationsKey();

    const description =
        book.cover_prompt ||
        "Professional premium ebook cover for " + book.title;

    const coverPrompt = `

Create a beautiful, professional square ebook cover.

BOOK TITLE:
${book.title}

ART DIRECTION:
${description}

Requirements:

- Square composition.
- Premium publishing quality.
- Beautiful professional typography.
- Visually attractive.
- Appropriate imagery for the book topic.
- Strong contrast.
- Balanced layout.
- Clear readable title.
- No watermarks.
- No unnecessary text.
- No mockup of a physical book.
- Actual flat front-cover artwork.

`;

    const url =
        CONFIG.POLLINATIONS_URL +
        "/image/" +
        encodeURIComponent(coverPrompt) +
        "?model=" +
        encodeURIComponent(CONFIG.IMAGE_MODEL) +
        "&width=512&height=512&nologo=true";

    const response = await secureFetch(

        url,

        {

            method: "GET",

            headers: {

                "Authorization": "Bearer " + key

            }

        },

        120000

    );

    if (!response.ok) {

        const message = await response.text();

        throw error(
            "Cover generation failed: " +
            message.substring(0,200),
            502
        );

    }

    const contentType =
        response.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {

        throw error(
            "The cover service did not return an image.",
            502
        );

    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    if (
        buffer.length === 0 ||
        buffer.length > 3 * 1024 * 1024
    ) {

        throw error(
            "The generated cover has an invalid file size.",
            502
        );

    }

    const base64 = buffer.toString("base64");

    return (
        "data:" +
        contentType +
        ";base64," +
        base64
    );

}


/* =====================================================
   GENERATE COMPLETE EBOOK
===================================================== */

async function generateEbook(body) {

    const prompt = body.prompt;

    if (
        typeof prompt !== "string" ||
        !prompt.trim()
    ) {

        throw error(
            "Please describe the ebook you want to create."
        );

    }

    if (
        prompt.length >
        CONFIG.MAX_PROMPT_LENGTH
    ) {

        throw error(
            "Your ebook description is too long."
        );

    }

    const aiResponse = await generateText(
        prompt.trim()
    );

    const rawBook = extractJSON(aiResponse);

    const book = validateBook(rawBook);

    let cover;

    try {

        cover = await generateCover(book);

    } catch (err) {

        /*
        A cover-generation error should not destroy
        an otherwise successfully generated ebook.

        The frontend uses background.png as fallback.
        */

        console.error(
            "Indorila cover generation error:",
            err.message
        );

        cover = null;

    }

    return {

        success: true,

        book: {

            title: book.title,

            introduction: book.introduction,

            chapters: book.chapters,

            conclusion: book.conclusion,

            cover_url: cover

        }

    };

}


/* =====================================================
   PAYMEGATE PAYMENT CREATION
===================================================== */

async function createPayment(body) {

    const apiKey = getPaymegateKey();

    const siteURL = getSiteURL();

    /*
    Never accept a client-controlled payment amount.

    The server fixes the price at $6.00.
    */

    const externalId =
        "indorila_" + crypto.randomUUID();

    const bookTitle =
        typeof body.book_title === "string"
            ? body.book_title.substring(0,150)
            : "Indorila Ebook";

    const backURL =
        siteURL +
        "/?reference=" +
        encodeURIComponent(externalId);

    const orderPayload = {

        externalId: externalId,

        amount: CONFIG.PRICE,

        currency: CONFIG.CURRENCY,

        paymentMethodsKeys: ["*"],

        backUrl: backURL,

        metadata: {

            product: "Indorila ebook AI PDF",

            bookTitle: bookTitle,

            price: CONFIG.PRICE,

            currency: CONFIG.CURRENCY

        }

    };

    const response = await secureFetch(

        CONFIG.PAYMEGATE_URL + "/v1/orders",

        {

            method: "POST",

            headers: {

                "X-API-Key": apiKey,

                "Content-Type": "application/json"

            },

            body: JSON.stringify(orderPayload)

        },

        30000

    );

    const result = await readJSON(response);

    const order = result.data || result;

    if (result.success === false) {

        throw error(
            "Paymegate could not create the order.",
            502
        );

    }

    if (
        !order.checkoutUrl ||
        !order.externalId
    ) {

        throw error(
            "Paymegate returned an incomplete order.",
            502
        );

    }

    const checkout = new URL(order.checkoutUrl);

    if (
        checkout.protocol !== "https:" ||
        ![
            "www.paymegate.com",
            "paymegate.com"
        ].includes(checkout.hostname)
    ) {

        throw error(
            "Paymegate returned an invalid checkout address.",
            502
        );

    }

    if (order.externalId !== externalId) {

        throw error(
            "Payment reference verification failed.",
            502
        );

    }

    return {

        success: true,

        checkout_url: order.checkoutUrl,

        reference: externalId

    };

}


/* =====================================================
   PAYMEGATE PAYMENT VERIFICATION
===================================================== */

async function verifyPayment(body) {

    const apiKey = getPaymegateKey();

    const reference = body.reference;

    if (
        typeof reference !== "string" ||
        !/^indorila_[a-f0-9-]{36}$/i.test(reference)
    ) {

        throw error(
            "Invalid payment reference."
        );

    }

    const url =
        CONFIG.PAYMEGATE_URL +
        "/v1/orders/by-external-id/" +
        encodeURIComponent(reference);

    const response = await secureFetch(

        url,

        {

            method: "GET",

            headers: {

                "X-API-Key": apiKey,

                "Accept": "application/json"

            }

        },

        30000

    );

    const result = await readJSON(response);

    const order = result.data || result;

    if (result.success === false) {

        throw error(
            "Unable to verify payment.",
            502
        );

    }

    if (
        order.externalId !== reference
    ) {

        throw error(
            "The payment reference does not match.",
            403
        );

    }

    if (
        String(order.status).toUpperCase() !== "PAID"
    ) {

        return {

            success: true,

            paid: false,

            status: order.status || "UNPAID"

        };

    }

    if (
        Number(order.amount) !== 6 ||
        String(order.currency).toUpperCase() !== "USD"
    ) {

        throw error(
            "The payment amount or currency does not match.",
            403
        );

    }

    return {

        success: true,

        paid: true,

        status: "PAID"

    };

}


/* =====================================================
   MAIN API HANDLER
===================================================== */

module.exports = async function handler(req,res) {

    if (req.method !== "POST") {

        res.setHeader("Allow","POST");

        return send(res,405,{

            success: false,

            error: "Method not allowed."

        });

    }

    try {

        const body = getBody(req);

        const action = body.action;

        if (!action) {

            throw error(
                "An API action is required."
            );

        }

        let result;

        switch(action) {

            case "generate":

                result = await generateEbook(body);

                break;


            case "create_payment":

                result = await createPayment(body);

                break;


            case "verify_payment":

                result = await verifyPayment(body);

                break;


            default:

                throw error(
                    "Unknown API action."
                );

        }

        return send(res,200,result);

    } catch(err) {

        console.error(
            "INDORILA API ERROR:",
            err.message
        );

        return send(

            res,

            err.statusCode || 500,

            {

                success: false,

                error:
                    err.statusCode && err.statusCode < 500
                        ? err.message
                        : "The request could not be completed. Please try again."

            }

        );

    }

};
