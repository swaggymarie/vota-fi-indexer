// app.js
import express from "express";
import sqlite3 from "sqlite3";
const cron = require("node-cron");
const cors = require("cors");
import web3js from "@solana/web3.js";
import { web3 } from "@coral-xyz/anchor";
import { PublicKey } from '@solana/web3.js';
import { Request, Response } from 'express';
import * as borsh from '@project-serum/borsh'
import { BN } from '@coral-xyz/anchor';
require('dotenv').config()

export interface Escrow {
  locker: PublicKey;
  owner: PublicKey;
  bump: number;
  tokens: PublicKey;
  amount: bigint;
  escrowStartedAt: bigint;
  escrowEndsAt: bigint;
  voteDelegate: PublicKey;
}
if(!process.env.HELIUS_RPC_URL){
  throw Error("Please provide a RPC URL in your env.")
}
const connection = new web3js.Connection(process.env.HELIUS_RPC_URL)

const app = express();
const db = new sqlite3.Database("data.db");
app.use(
  cors({
    origin: "http://localhost:3000", // Replace with your Next.js app's URL
  })
);

// Define database schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS veSbrAmount (
        id INTEGER PRIMARY KEY,
        value TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  db.run(`CREATE TABLE IF NOT EXISTS nbEscrows (
      id INTEGER PRIMARY KEY,
      total INTEGER,
      delegated INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Schedule job to run every hour
cron.schedule("0 * * * *", () => {
  async function getAccounts() {
    const LOCKED_VOTER_PROGRAM_ID = new web3.PublicKey("LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw");
    try {

      const allAccounts = await connection.getProgramAccounts(LOCKED_VOTER_PROGRAM_ID, {
        dataSlice: {
          length: 0,
          offset: 0,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait for 30 seconds

      const accounts = await connection.getProgramAccounts(LOCKED_VOTER_PROGRAM_ID, {
        filters: [
          {
            dataSize: 8 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 32,
          },
          {
            memcmp: {
              offset: 8 + 32 + 32 + 1 + 32 + 8 + 8 + 8,
              bytes: "Fm53VwAiMfGBprgh83x6v5fYKfiq7yQWgUCZKSdYzHPk", // Specify the voteDelegate public key
            },
          },
        ],
      });

      const borshAccount = borsh.struct([
        borsh.u64("discriminator"),
        borsh.publicKey('locker'),
        borsh.publicKey('owner'),
        borsh.u8("bump"),
        borsh.publicKey("tokens"),
        borsh.u64("amount"),
        borsh.i64('escrowStartedAt'),
        borsh.i64('escrowEndsAt'),
        borsh.publicKey("voteDelegate")
      ])

      let totalVeSbr = 0

      const maxStakeVoteMultiplier = 10
      const maxStakeDuration = new BN(157680000)
      accounts.map(async ({ pubkey, account }: { pubkey: PublicKey, account: any }) => {
        const _decoded = borshAccount.decode(account.data);
        const timeLeft = _decoded.escrowEndsAt.sub(new BN(Date.now() / 1000));
        const veSBR =
          (_decoded.amount.toNumber() *
            maxStakeVoteMultiplier *
            timeLeft.toNumber()) /
          maxStakeDuration.toNumber() /
          1_000_000;

        totalVeSbr += veSBR;
      });

      db.run(`INSERT INTO veSbrAmount (value) VALUES (?)`, [totalVeSbr], (err: any) => {
        if (err) {
          console.error("Error moving totalVeSbr to historical data:", err);
        }
      })
      db.run(`INSERT INTO nbEscrows (total, delegated) VALUES (?, ?)`, [allAccounts.length, accounts.length], (err: any) => {
        if (err) {
          console.error("Error moving totalVeSbr to historical data:", err);
        }
      })


    } catch (e) {
      console.log(e);
    }
  }
  getAccounts();

});

app.get("/veSbr", (req: Request, res: Response) => {
  db.all(`SELECT * FROM veSbrAmount`, (err: any, rows: any) => {
    if (err) {
      console.error("Error fetching actual data:", err);
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.json(rows);
    }
  });
});

app.get("/escrows", (req: Request, res: Response) => {
  db.all(`SELECT * FROM nbEscrows`, (err: any, rows: any) => {
    if (err) {
      console.error("Error fetching actual data:", err);
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.json(rows);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});