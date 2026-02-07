
-- Add bom_group_id to identify BOM chains
ALTER TABLE public.boms ADD COLUMN bom_group_id uuid;

-- Backfill: for each chain (customer_id + project_name), set bom_group_id to the id of the earliest BOM
WITH chain_groups AS (
  SELECT 
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY customer_id, project_name 
      ORDER BY version ASC, created_at ASC
    ) AS group_id
  FROM public.boms
)
UPDATE public.boms b
SET bom_group_id = cg.group_id
FROM chain_groups cg
WHERE b.id = cg.id;

-- Make it NOT NULL after backfill
ALTER TABLE public.boms ALTER COLUMN bom_group_id SET NOT NULL;

-- Default for new rows: gen_random_uuid() (new chains get a fresh group id)
ALTER TABLE public.boms ALTER COLUMN bom_group_id SET DEFAULT gen_random_uuid();

-- Add index for efficient chain lookups
CREATE INDEX idx_boms_group_id ON public.boms (bom_group_id);
