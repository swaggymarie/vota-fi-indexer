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
import { Client } from 'pg';
require('dotenv').config()

const client = new Client({
  connectionString: process.env.ENVIRONMNENT == "production" ? process.env.DATABASE_PRIVATE_URL : process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect();

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
if (!process.env.HELIUS_RPC_URL) {
  throw Error("Please provide a RPC URL in your env.")
}
const connection = new web3js.Connection(process.env.HELIUS_RPC_URL)

const app = express();

const allowedOrigins = ["http://localhost:3000", "https://vota-front.vercel.app", "https://vota.fi", "https://themetadao.org"];

app.use(cors({
  origin: function (origin: any, callback: any) {
    if (!origin) return callback(null, false);
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'The CORS policy for this site does not ' +
        'allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

// Define database schema
client.query(`
  CREATE TABLE IF NOT EXISTS escrows (
    id SERIAL PRIMARY KEY,
    veSbrAmount FLOAT,
    nbTotal INTEGER,
    nbDelegated INTEGER,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )
`, (err, res) => {
  if (err) throw err;
});

client.query(`
  CREATE TABLE IF NOT EXISTS gauges (
    id SERIAL PRIMARY KEY,
    gaugeMeister TEXT,
    quarry TEXT,
    address TEXT
  )
`, (err, res) => {
  if (err) throw err;
});


const gaugeProgramId = new PublicKey('GaugesLJrnVjNNWLReiw3Q7xQhycSBRgeHGTMDUaX231')

async function setGauges() {
  const borshAccount = borsh.struct([
    borsh.u64("discriminator"),
    borsh.publicKey('gaugemeister'),
    borsh.publicKey('quarry'),
    borsh.bool("isDisabled"),
  ])
  let accounts = await connection.getProgramAccounts(gaugeProgramId, { filters: [{ dataSize: borshAccount.span }, { memcmp: { offset: 8, bytes: "28ZDtf6d2wsYhBvabTxUHTRT6MDxqjmqR7RMCp348tyU" } }] })
  let decodedAccounts = await Promise.all(accounts.map(async (account) => {
    let gauge = borshAccount.decode(account.account.data)
    gauge.address = account.pubkey.toString()
    if (!gauge.isDisabled)
      return gauge
  }))
  decodedAccounts = decodedAccounts.filter((gauge) => gauge !== undefined);
  
  // Delete all existing rows in the gauges table
  client.query(`DELETE FROM gauges`, (err: any) => {
    if (err) {
      console.error("Error deleting existing rows:", err);
    } else {
      // Insert all decodedAccounts
      const values = decodedAccounts.map((gauge) => [gauge.gaugemeister, gauge.quarry, gauge.address]);
      client.query(`INSERT INTO gauges (gaugeMeister, quarry, address) VALUES $1`, [values], (err: any) => {
        if (err) {
          console.error("Error inserting decodedAccounts:", err);
        }
      });
    }
  });
}

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
              bytes: "HQNBakKUm5sWqDwMeB36LFYFWEoBEgTGAUKnVgH3PN8H", // Specify the voteDelegate public key
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

      client.query(`INSERT INTO escrows (veSbrAmount, nbTotal, nbDelegated) VALUES ($1, $2, $3)`, [totalVeSbr, allAccounts.length, accounts.length], (err: any) => {
        if (err) {
          console.error("Error moving totalVeSbr to veSbrAmount data:", err);
        }
      })

      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait for 30 seconds
      setGauges()

    } catch (e) {
      console.log(e);
    }
  }
  getAccounts();
});

app.get("/escrows", (req: Request, res: Response) => {
  client.query(`SELECT * FROM escrows`, (err, result) => {
    if (err) {
      console.error("Error fetching actual data:", err);
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.json(result.rows);
    }
  });
});

app.get("/gauges", (req: Request, res: Response) => {
  client.query(`SELECT * FROM gauges`, (err, result) => {
    if (err) {
      console.error("Error fetching actual data:", err);
      res.status(500).json({ error: "Internal server error" });
    } else {
      res.json(result.rows);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
