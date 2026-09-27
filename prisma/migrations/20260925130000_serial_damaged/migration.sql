-- A serialised unit a customer brought back damaged: back in the shop but
-- written off, so it can never be scanned into a sale again. Before this, a
-- return could only put the unit back IN_STOCK, sellable.
ALTER TYPE "SerialStatus" ADD VALUE 'DAMAGED';
