-- Each new payment intent can retain its original encrypted merchant context.
-- Rotation of current organisation settings must not rebind existing references.
ALTER TABLE "Payment" ADD COLUMN "providerConfigEncrypted" TEXT;
CREATE FUNCTION protect_payment_provider_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."providerConfigEncrypted" IS NOT NULL AND NEW."providerConfigEncrypted" IS DISTINCT FROM OLD."providerConfigEncrypted" THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_BINDING_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_payment_provider_binding BEFORE UPDATE ON "Payment"
FOR EACH ROW EXECUTE FUNCTION protect_payment_provider_binding();
