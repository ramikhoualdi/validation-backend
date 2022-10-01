"use strict";

require("dotenv").config();

const APPLE_SHARED_SECRET = "";
const IAP_TEST_MODE = true;

const http = require("http");
const express = require("express");
const iap = require("in-app-purchase");
const assert = require("assert");
// const Knex = require("knex");
const moment = require("moment");
const asyncHandler = require("express-async-handler");
const { JWT } = require("google-auth-library");
const { google } = require("googleapis");
const account = require("./service-account.json");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

google.options({
  auth: new JWT(account.client_email, null, account.private_key, [
    "https://www.googleapis.com/auth/androidpublisher",
  ]),
});

const androidGoogleApi = google.androidpublisher({ version: "v3" });

async function getActiveSubscriptions() {
  const subRef = db.collection("subscriptions");
  const subscription = await subRef
    .where("end_date", ">=", new Date())
    .where("fake", false)
    .get();
  console.log(subscription);
  return subscription;
}

async function updateSubscription({
  app,
  environment,
  origTxId,
  userId,
  validationResponse,
  latestReceipt,
  startDate,
  endDate,
  productId,
  isCancelled,
}) {
  const data = {
    app,
    environment,
    user_id: userId,
    orig_tx_id: origTxId,
    validation_response: JSON.stringify(validationResponse),
    latest_receipt: latestReceipt,
    start_date: startDate,
    end_date: endDate,
    product_id: productId,
    is_cancelled: isCancelled,
  };

  try {
    // await knex("subscriptions").insert(data);
    const res = await db.collection("subscriptions").add(data);
    console.log("Added document with ID: ", res.id);
  } catch (err) {
    if (err.code !== "ER_DUP_ENTRY") throw err;
    const res = await db
      .collection("subscriptions")
      .where("orig_tx_id", origTxId)
      .get();
    const subRef = db.collection("subscriptions").doc(res.id);
    await subRef.update(data);
    // await knex("subscriptions").where("orig_tx_id", origTxId).update(data);
  }
}

async function getUserSubscription(userId, appType) {
  if (!appType) return undefined;

  //   const row = await knex("subscriptions")
  //     .where({ user_id: userId, app: appType })
  //     .select(["start_date", "end_date", "product_id", "is_cancelled"])
  //     .orderBy("start_date", "desc")
  //     .first();
  const row = await db
    .collection("subscriptions")
    .where("user_id", "=", userId)
    .where("app", "=", appType)
    .orderBy("start_date", "desc")
    .limit(1)
    .get();

  if (!row) return undefined;

  return {
    startDate: row.start_date,
    endDate: row.end_date,
    productId: row.product_id,
    isCancelled: !!row.is_cancelled,
    type: "iap",
  };
}

async function processPurchase(app, userId, receipt) {
  await iap.setup();
  const validationResponse = await iap.validate(receipt);

  // Sanity check
  assert(
    (app === "android" && validationResponse.service === "google") ||
      (app === "ios" && validationResponse.service === "apple")
  );

  const purchaseData = iap.getPurchaseData(validationResponse);
  const firstPurchaseItem = purchaseData[0];

  const isCancelled = iap.isCanceled(firstPurchaseItem);
  // const isExpired = iap.isExpired(firstPurchaseItem);
  const { productId } = firstPurchaseItem;
  const origTxId =
    app === "ios"
      ? firstPurchaseItem.originalTransactionId
      : firstPurchaseItem.transactionId;
  const latestReceipt =
    app === "ios" ? validationResponse.latest_receipt : JSON.stringify(receipt);
  const startDate =
    app === "ios"
      ? new Date(firstPurchaseItem.originalPurchaseDateMs)
      : new Date(parseInt(firstPurchaseItem.startTimeMillis, 10));
  const endDate =
    app === "ios"
      ? new Date(firstPurchaseItem.expiresDateMs)
      : new Date(parseInt(firstPurchaseItem.expiryTimeMillis, 10));

  let environment = "";
  // validationResponse contains sandbox: true/false for Apple and Amazon
  // Android we don't know if it was a sandbox account
  if (app === "ios") {
    environment = validationResponse.sandbox ? "sandbox" : "production";
  }

  await updateSubscription({
    userId,
    app,
    environment,
    productId,
    origTxId,
    latestReceipt,
    validationResponse,
    startDate,
    endDate,
    isCancelled,
  });

  // From https://developer.android.com/google/play/billing/billing_library_overview:
  // You must acknowledge all purchases within three days.
  // Failure to properly acknowledge purchases results in those purchases being refunded.
  if (app === "android" && validationResponse.acknowledgementState === 0) {
    await androidGoogleApi.purchases.subscriptions.acknowledge({
      packageName: androidPackageName,
      subscriptionId: productId,
      token: receipt.purchaseToken,
    });
  }
}

async function validateAllSubscriptions() {
  const subscriptions = await getActiveSubscriptions();
  for (const subscription of subscriptions) {
    try {
      if (subscription.app === "ios") {
        await processPurchase(
          subscription.app,
          subscription.user_id,
          subscription.latest_receipt
        );
      } else {
        await processPurchase(
          subscription.app,
          subscription.user_id,
          JSON.parse(subscription.latest_receipt)
        );
      }
    } catch (err) {
      console.error("Failed to validate subscription", subscription.id);
    }
  }
}

function checkIfHasSubscription(subscription) {
  if (!subscription) return false;
  if (subscription.isCancelled) return false;
  const nowMs = new Date().getTime();
  return (
    moment(subscription.startDate).valueOf() <= nowMs &&
    moment(subscription.endDate).valueOf() >= nowMs
  ); // TODO grace period?
}

const iapTestMode = IAP_TEST_MODE === "true";
const androidPackageName = "com.superstudiouniverse.quizy";

// https://www.appypie.com/faqs/how-can-i-get-shared-secret-key-for-in-app-purchase
iap.config({
  // If you want to exclude old transaction, set this to true. Default is false:
  appleExcludeOldTransactions: true,
  // this comes from iTunes Connect (You need this to valiate subscriptions):
  applePassword: APPLE_SHARED_SECRET,

  googleServiceAccount: {
    clientEmail: account.client_email,
    privateKey: account.private_key,
  },

  /* Configurations all platforms */
  test: iapTestMode, // For Apple and Google Play to force Sandbox validation only
  // verbose: true, // Output debug logs to stdout stream
});

const app = express();
const server = http.Server(app);

app.use((req, res, next) => {
  // TODO Your auth middleware
  req.userId = 123;
  next();
});

server.listen(8080);

app.post(
  "/iap/save-receipt",
  asyncHandler(async (req, res) => {
    const { userId } = req;
    const { appType, purchase } = req.body;

    assert(["ios", "android"].includes(appType));

    const receipt =
      appType === "ios"
        ? purchase.transactionReceipt
        : {
            packageName: androidPackageName,
            productId: purchase.productId,
            purchaseToken: purchase.purchaseToken,
            subscription: true,
          };

    await processPurchase(appType, userId, receipt);
    res.end();
  })
);

app.get(
  "/iap/user-subscription/:appType",
  asyncHandler(async (req, res) => {
    const { userId } = req;
    const { appType } = req.params;

    const subscription = await getUserSubscription(userId, appType);
    res.send({
      subscription,
      hasSubscription: checkIfHasSubscription(subscription),
    });
    res.end();
  })
);

setInterval(validateAllSubscriptions, 24 * 60 * 60 * 1000);
