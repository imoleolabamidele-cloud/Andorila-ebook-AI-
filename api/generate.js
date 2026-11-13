"use strict";

/*
=========================================================
INDORILA EBOOK AI
Backend API
File: api/generate.js

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

/* RESPONSE HELPERS */

function send(res,status,data){
    res.statusCode=status;
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
    res.setHeader("X-Content-Type-Options","nosniff");
    return res.end(JSON.stringify(data));
}

function error(message,status=400){
    const err=new Error(message);
    err.statusCode=status;
    return err;
}

function getBody(req){
    if(req.body&&typeof req.body==="object") return req.body;

    if(typeof req.body==="string"){
        try{return JSON.parse(req.body)}
        catch{throw error("Invalid JSON request.")}
    }
    return {};
}

/* ENVIRONMENT CONFIGURATION */

function getPollinationsKey(){
    const key=process.env.POLLINATIONS_API_KEY;

    if(!key) throw error("Pollinations API key is not configured.",503);
    if(!key.startsWith("sk_"))
        throw error("Invalid Pollinations secret key configuration.",503);

    return key;
}

function getPaymegateKey(){
    const key=process.env.PAYMEGATE_API_KEY;
    if(!key) throw error("Paymegate API key is not configured.",503);
    return key;
}

function getSiteURL(){
    const value=process.env.SITE_URL;
    if(!value) throw error("SITE_URL must be configured before creating payments.",503);

    let parsed;
    try{parsed=new URL(value)}
    catch{throw error("Invalid SITE_URL configuration.",503)}

    if(parsed.protocol!=="https:")
        throw error("SITE_URL must use HTTPS.",503);

    return parsed.origin;
}

/* FETCH WITH TIMEOUT */

async function secureFetch(url,options={},timeout=60000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);

    try{
        return await fetch(url,{...options,signal:controller.signal});
    }catch(err){
        if(err.name==="AbortError")
            throw error("The external service took too long to respond.",504);
        throw err;
    }finally{
        clearTimeout(timer);
    }
}

/* SAFE RESPONSE PARSING */

async function readJSON(response){
    const text=await response.text();
    let data;

    try{data=JSON.parse(text)}
    catch{throw error("The external service returned an invalid response.",502)}

    if(!response.ok){
        const message=data?.error?.message||
            data?.message||
            "External service request failed.";
        throw error(message,502);
    }
    return data;
}

/* TEXT GENERATION */

async function generateText(prompt){
    const key=getPollinationsKey();

    const systemPrompt=`
You are the professional ebook-writing engine for Indorila ebook AI.

Your task is to turn the user's idea into a professionally written,
coherent and useful ebook. Expand short ideas thoughtfully.

CONTENT RULES:
- Determine the appropriate number of chapters automatically.
- You may generate fewer chapters when the topic is narrow.
- The absolute maximum is 30 chapters. Never exceed it.
- Each chapter must contain substantive explanations, useful details,
  examples where appropriate, and a logical progression.
- Do not return chapter titles with only a few sentences.
- Do not use filler or repeat the same ideas.
- Write a detailed introduction and a meaningful conclusion.
- Use Markdown **bold** formatting for important terms and concepts.
- Do not invent citations, statistics, sources, or factual claims.
- Keep the writing relevant to the user's requested topic.
- Respect applicable safety requirements.

OUTPUT:
Return one valid JSON object only. No Markdown fences or commentary.

Use this structure:
{
  "title": "Book title",
  "introduction": "Detailed introduction",
  "chapters": [
    {
      "title": "Chapter title",
      "content": "Substantial chapter content with **bold** formatting"
    }
  ],
  "conclusion": "Detailed conclusion",
  "cover_prompt": "Professional square ebook cover description"
}

The chapters field MUST be an array of objects. Every chapter object
must contain a non-empty title and a non-empty content string.
Never generate more than 30 chapters.
`;

    const response=await secureFetch(
        CONFIG.POLLINATIONS_URL+"/v1/chat/completions",
        {
            method:"POST",
            headers:{
                "Authorization":"Bearer "+key,
                "Content-Type":"application/json",
                "Pollinations-Safe":"privacy,secrets,sexual,violence"
            },
            body:JSON.stringify({
                model:CONFIG.TEXT_MODEL,
                messages:[
                    {role:"system",content:systemPrompt},
                    {role:"user",content:prompt}
                ],
                temperature:0.7,
                max_tokens:24000,
                response_format:{type:"json_object"},
                stream:false
            })
        },
        CONFIG.REQUEST_TIMEOUT
    );

    return await readJSON(response);
}

/* EXTRACT MODEL CONTENT */

function getMessageContent(data){
    const message=data?.choices?.[0]?.message;
    let content=message?.content;

    if(typeof content==="string") return content;

    if(Array.isArray(content)){
        return content.map(item=>{
            if(typeof item==="string") return item;
            return item?.text||item?.content||"";
        }).join("\n");
    }

    if(content&&typeof content==="object") return JSON.stringify(content);

    if(typeof data?.output_text==="string") return data.output_text;

    throw error("The AI did not return ebook content.",502);
}

function extractJSON(data){
    let content=getMessageContent(data).trim();

    content=content
        .replace(/^```(?:json)?\s*/i,"")
        .replace(/\s*```$/,"")
        .trim();

    try{return JSON.parse(content)}
    catch{
        const first=content.indexOf("{");
        const last=content.lastIndexOf("}");

        if(first<0||last<=first)
            throw error("The AI returned incomplete ebook data.",502);

        try{return JSON.parse(content.slice(first,last+1))}
        catch{throw error("The generated ebook could not be parsed.",502)}
    }
}
/* CHAPTER NORMALIZATION */

function firstString(object,keys){
    for(const key of keys){
        if(typeof object?.[key]==="string"&&object[key].trim())
            return object[key].trim();
    }
    return "";
}

function normalizeChapter(chapter,index){
    if(typeof chapter==="string"){
        const value=chapter.trim();
        const separator=value.indexOf("\n");

        if(separator>0){
            return {
                title:value.slice(0,separator).trim(),
                content:value.slice(separator+1).trim()
            };
        }
        return {title:"Chapter "+(index+1),content:value};
    }

    if(!chapter||typeof chapter!=="object") return null;

    const title=firstString(chapter,[
        "title","chapter_title","heading","name"
    ]);

    const content=firstString(chapter,[
        "content","chapter_content","body","text","description"
    ]);

    if(!title||!content) return null;
    return {title,content};
}

function normalizeChapters(value){
    let source=value;

    if(source&& !Array.isArray(source)&&typeof source==="object"){
        source=Object.entries(source).map(([title,content])=>{
            if(typeof content==="string") return {title,content};
            if(content&&typeof content==="object")
                return {...content,title:content.title||title};
            return null;
        });
    }

    if(!Array.isArray(source)) return null;

    return source.map((chapter,index)=>normalizeChapter(chapter,index));
}

/* EBOOK VALIDATION */

function validateBook(book){
    if(!book||typeof book!=="object"||Array.isArray(book))
        throw error("Invalid ebook response.",502);

    const title=firstString(book,["title","book_title","name"]);
    const introduction=firstString(book,["introduction","intro","opening"]);
    const conclusion=firstString(book,["conclusion","ending","final_thoughts"]);
    const chapters=normalizeChapters(book.chapters??book.sections);

    if(!title) throw error("The ebook title is missing.",502);
    if(!introduction) throw error("The ebook introduction is incomplete.",502);
    if(!conclusion) throw error("The ebook conclusion is incomplete.",502);

    if(!chapters||chapters.length<1||chapters.length>CONFIG.MAX_CHAPTERS){
        console.error("INDORILA CHAPTER DIAGNOSTIC:",{
            keys:Object.keys(book),
            chaptersType:typeof book.chapters,
            isArray:Array.isArray(book.chapters),
            chapterCount:Array.isArray(book.chapters)?book.chapters.length:null
        });
        throw error(
            "The generated ebook has an invalid chapter structure. Please try generating it again.",
            502
        );
    }

    for(let i=0;i<chapters.length;i++){
        const chapter=chapters[i];
        if(!chapter||!chapter.title||!chapter.content){
            throw error("Chapter "+(i+1)+" is incomplete.",502);
        }
    }

    return {
        title,
        introduction,
        chapters,
        conclusion,
        cover_prompt:firstString(book,["cover_prompt","cover_description"])
    };
}

/* COVER GENERATION */

async function generateCover(book){
    const key=getPollinationsKey();

    const description=book.cover_prompt||
        "Professional premium ebook cover for "+book.title;

    const prompt=`
Create professional square ebook cover artwork.

BOOK TITLE: ${book.title}

ART DIRECTION: ${description}

Requirements:
- Square composition.
- Premium publishing quality.
- Appropriate imagery for the subject.
- Strong contrast and balanced layout.
- Clear, readable title.
- No watermarks.
- No unnecessary text.
- No physical-book mockup.
- Flat front-cover artwork.
`;

    const url=CONFIG.POLLINATIONS_URL+
        "/image/"+encodeURIComponent(prompt)+
        "?model="+encodeURIComponent(CONFIG.IMAGE_MODEL)+
        "&width=512&height=512&nologo=true";

    const response=await secureFetch(url,{
        method:"GET",
        headers:{"Authorization":"Bearer "+key}
    },120000);

    if(!response.ok){
        const message=await response.text();
        throw error("Cover generation failed: "+message.substring(0,180),502);
    }

    const contentType=response.headers.get("content-type")||"";
    if(!contentType.startsWith("image/"))
        throw error("The cover service did not return an image.",502);

    const buffer=Buffer.from(await response.arrayBuffer());

    if(buffer.length===0||buffer.length>3*1024*1024)
        throw error("The generated cover has an invalid file size.",502);

    return "data:"+contentType+";base64,"+buffer.toString("base64");
}

/* GENERATE COMPLETE EBOOK */

async function generateEbook(body){
    const prompt=body.prompt;

    if(typeof prompt!=="string"||!prompt.trim())
        throw error("Please describe the ebook you want to create.");

    if(prompt.length>CONFIG.MAX_PROMPT_LENGTH)
        throw error("Your ebook description is too long.");

    const aiResponse=await generateText(prompt.trim());
    const rawBook=extractJSON(aiResponse);
    const book=validateBook(rawBook);

    let cover=null;

    try{
        cover=await generateCover(book);
    }catch(err){
        console.error("Indorila cover generation error:",err.message);
    }

    return {
        success:true,
        book:{
            title:book.title,
            introduction:book.introduction,
            chapters:book.chapters,
            conclusion:book.conclusion,
            cover_url:cover
        }
    };
}

/* CANONICAL PAYMENT CONTENT */

function canonicalBook(input){
    const book=validateBook(input);

    return {
        title:book.title,
        introduction:book.introduction,
        chapters:book.chapters.map(chapter=>({
            title:chapter.title,
            content:chapter.content
        })),
        conclusion:book.conclusion
    };
}

function getBookDigest(input){
    const canonical=canonicalBook(input);
    const serialized=JSON.stringify(canonical);

    return crypto.createHash("sha256")
        .update(serialized,"utf8")
        .digest("hex");
}

function validateEmail(value){
    if(typeof value!=="string") return false;
    const email=value.trim();
    if(email.length>254) return false;

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
/* PAYMEGATE PAYMENT CREATION */

async function createPayment(body){
    const apiKey=getPaymegateKey();
    const siteURL=getSiteURL();

    if(!validateEmail(body.customer_email))
        throw error("Please provide a valid customer email address.");

    if(!body.book||typeof body.book!=="object")
        throw error("The ebook details are missing.");

    const book=canonicalBook(body.book);
    const bookDigest=getBookDigest(book);

    const externalId="indorila_"+crypto.randomUUID();

    const backURL=siteURL+"/?reference="+encodeURIComponent(externalId);

    const payload={
        externalId,
        amount:CONFIG.PRICE,
        currency:CONFIG.CURRENCY,
        paymentMethodsKeys:["*"],
        customer:{
            email:body.customer_email.trim()
        },
        backUrl:backURL,
        metadata:{
            product:"Indorila ebook AI PDF",
            bookTitle:book.title.substring(0,150),
            bookDigest,
            price:CONFIG.PRICE,
            currency:CONFIG.CURRENCY
        }
    };

    const response=await secureFetch(
        CONFIG.PAYMEGATE_URL+"/v1/orders",
        {
            method:"POST",
            headers:{
                "X-API-Key":apiKey,
                "Content-Type":"application/json",
                "Accept":"application/json"
            },
            body:JSON.stringify(payload)
        },
        30000
    );

    const result=await readJSON(response);

    if(result.success===false)
        throw error("Paymegate could not create the order.",502);

    const order=result.data||result;

    if(!order.checkoutUrl||!order.externalId)
        throw error("Paymegate returned an incomplete order.",502);

    let checkout;

    try{checkout=new URL(order.checkoutUrl)}
    catch{throw error("Paymegate returned an invalid checkout address.",502)}

    if(
        checkout.protocol!=="https:"||
        !/(^|\.)paymegate\.com$/i.test(checkout.hostname)
    ){
        throw error("Paymegate returned an invalid checkout address.",502);
    }

    if(order.externalId!==externalId)
        throw error("Payment reference verification failed.",502);

    return {
        success:true,
        checkout_url:checkout.href,
        reference:externalId
    };
}

/* PAYMEGATE PAYMENT LOOKUP */

async function findPaymegateOrder(reference){
    const apiKey=getPaymegateKey();

    const url=CONFIG.PAYMEGATE_URL+
        "/v1/orders/by-external-id/"+
        encodeURIComponent(reference);

    const response=await secureFetch(url,{
        method:"GET",
        headers:{
            "X-API-Key":apiKey,
            "Accept":"application/json"
        }
    },30000);

    const result=await readJSON(response);

    if(result.success===false)
        throw error("Unable to verify payment.",502);

    const data=result.data||result;

    /*
      Paymegate's lookup response can contain
      data.items rather than a single order object.
    */
    let items;

    if(Array.isArray(data.items)){
        items=data.items;
    }else if(Array.isArray(data)){
        items=data;
    }else if(data&&typeof data==="object"){
        items=[data];
    }else{
        items=[];
    }

    const matches=items.filter(item=>
        item&&item.externalId===reference
    );

    if(matches.length===0)
        throw error("No matching payment order was found.",404);

    if(matches.length!==1)
        throw error("The payment reference is ambiguous.",409);

    return matches[0];
}

/* VERIFY PAYMENT AND EBOOK CONTENT */

async function verifyPayment(body){
    const reference=body.reference;

    if(
        typeof reference!=="string"||
        !/^indorila_[a-f0-9-]{36}$/i.test(reference)
    ){
        throw error("Invalid payment reference.");
    }

    if(!body.book||typeof body.book!=="object")
        throw error("The ebook details are missing.");

    const submittedDigest=getBookDigest(body.book);
    const order=await findPaymegateOrder(reference);

    if(order.externalId!==reference)
        throw error("The payment reference does not match.",403);

    const status=String(order.status||"").toUpperCase();

    if(status!=="PAID"){
        return {
            success:true,
            paid:false,
            status:status||"UNPAID"
        };
    }

    const amount=Number(order.amount);
    const currency=String(order.currency||"").toUpperCase();

    if(amount!==6||currency!=="USD")
        throw error("The payment amount or currency does not match.",403);

    const metadata=order.metadata||{};
    const storedDigest=metadata.bookDigest;

    if(
        typeof storedDigest!=="string"||
        !/^[a-f0-9]{64}$/i.test(storedDigest)||
        storedDigest!==submittedDigest
    ){
        throw error("The payment does not match this ebook.",403);
    }

    return {
        success:true,
        paid:true,
        status:"PAID"
    };
}
/* MAIN API HANDLER */

module.exports=async function handler(req,res){
    if(req.method!=="POST"){
        res.setHeader("Allow","POST");
        return send(res,405,{
            success:false,
            error:"Method not allowed."
        });
    }

    try{
        const body=getBody(req);
        const action=body.action;

        if(!action)
            throw error("An API action is required.");

        let result;

        switch(action){
            case "generate":
                result=await generateEbook(body);
                break;

            case "create_payment":
                result=await createPayment(body);
                break;

            case "verify_payment":
                result=await verifyPayment(body);
                break;

            default:
                throw error("Unknown API action.");
        }

        return send(res,200,result);

    }catch(err){
        console.error("INDORILA API ERROR:",err.message);

        const status=Number.isInteger(err.statusCode)
            ?err.statusCode:500;

        const publicMessage=status<500
            ?err.message
            :"The request could not be completed. Please try again.";

        return send(res,status,{
            success:false,
            error:publicMessage
        });
    }
};