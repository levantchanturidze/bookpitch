import React, { useState, useMemo } from 'react';
import {
  CreditCard,
  DollarSign,
  Sparkles,
  Receipt,
  Check,
  ShoppingBag,
  Percent,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import { Appointment, Patient, WorkspaceMode } from '@/lib/types';
import { motion, AnimatePresence } from 'motion/react';

interface CheckoutPaymentProps {
  mode: WorkspaceMode;
  appointments: Appointment[];
  patients: Patient[];
  onCompletePayment: (appointmentId: string) => void;
}

export default function CheckoutPayment({
  mode,
  appointments,
  patients,
  onCompletePayment,
}: CheckoutPaymentProps) {
  const isClinic = mode === 'clinic';
  const patientLabel = isClinic ? 'Patient' : 'Client';

  // State
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [promoCode, setPromoCode] = useState('');
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [appliedPromo, setAppliedPromo] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'apple' | 'google' | 'cash'>('card');

  // Stripe form simulation fields
  const [cardNumber, setCardNumber] = useState('4242 •••• •••• 4242');
  const [cardExpiry, setCardExpiry] = useState('12/28');
  const [cardCvc, setCardCvc] = useState('341');
  const [cardName, setCardName] = useState('');

  // Receipt modal state
  const [isProcessing, setIsProcessing] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [paidAppointment, setPaidAppointment] = useState<Appointment | null>(null);
  const [promoError, setPromoError] = useState('');
  const [receiptStatus, setReceiptStatus] = useState('');

  // Unpaid appointments list
  const unpaidAppointments = useMemo(() => {
    return appointments.filter((a) => a.paymentStatus === 'unpaid' && a.status !== 'cancelled');
  }, [appointments]);

  // Selected appointment details
  const activeApp = useMemo(() => {
    return appointments.find((a) => a.id === selectedAppId) || unpaidAppointments[0];
  }, [appointments, selectedAppId, unpaidAppointments]);

  // Active Patient details
  const activePatient = useMemo(() => {
    if (!activeApp) return null;
    return patients.find((p) => p.id === activeApp.patientId) || null;
  }, [patients, activeApp]);

  // Calculations
  const calculations = useMemo(() => {
    if (!activeApp) return { subtotal: 0, tax: 0, discount: 0, total: 0 };
    const subtotal = activeApp.price;
    const discount = subtotal * (discountPercentage / 100);
    const tax = (subtotal - discount) * 0.0825; // 8.25% Sales tax
    const total = subtotal - discount + tax;

    return { subtotal, tax, discount, total };
  }, [activeApp, discountPercentage]);

  // Handle promo code submit
  const handleApplyPromo = (e: React.FormEvent) => {
    e.preventDefault();
    setPromoError('');
    const code = promoCode.trim().toUpperCase();
    if (code === 'HEALTH15' && isClinic) {
      setDiscountPercentage(15);
      setAppliedPromo('HEALTH15 (15%)');
    } else if (code === 'GLOW20' && !isClinic) {
      setDiscountPercentage(20);
      setAppliedPromo('GLOW20 (20%)');
    } else if (code === 'WELCOME10') {
      setDiscountPercentage(10);
      setAppliedPromo('WELCOME10 (10%)');
    } else {
      setPromoError('Invalid or expired promotional code.');
    }
    setPromoCode('');
  };

  // Process secure simulation
  const handleProcessCheckout = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeApp) return;

    setIsProcessing(true);

    // Simulate safe Stripe/gateway processing network delay
    setTimeout(() => {
      setIsProcessing(false);
      setPaidAppointment(activeApp);
      setShowReceipt(true);
      onCompletePayment(activeApp.id);
      setSelectedAppId('');
      setDiscountPercentage(0);
      setAppliedPromo('');
    }, 1500);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" id="checkout-payment-root">
      {/* Checkout Selector & Totals (6 Columns) */}
      <div
        className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6"
        id="checkout-totals-card"
      >
        <div>
          <div className="mb-4 flex items-center gap-2">
            <div
              className={`rounded-lg p-2 ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}
            >
              <ShoppingBag className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Checkout Terminal</h3>
              <p className="text-[10px] text-slate-400">
                Process secure point-of-sale customer settlement
              </p>
            </div>
          </div>

          {/* Selector input */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-500">
                Select Active Unpaid Visit
              </label>
              <select
                value={selectedAppId}
                onChange={(e) => setSelectedAppId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
              >
                {unpaidAppointments.length === 0 ? (
                  <option value="">No active unpaid appointments found</option>
                ) : (
                  <>
                    <option value="">-- Choose Appointment --</option>
                    {unpaidAppointments.map((app) => {
                      const patient = patients.find((p) => p.id === app.patientId);
                      return (
                        <option key={app.id} value={app.id}>
                          {patient?.name} - {app.service} (${app.price})
                        </option>
                      );
                    })}
                  </>
                )}
              </select>
            </div>

            {activeApp ? (
              <div className="space-y-3.5 rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                <div className="flex items-start justify-between border-b border-slate-100 pb-2.5 text-xs">
                  <div>
                    <span className="block font-mono text-[10px] tracking-wider text-slate-400 uppercase">
                      {patientLabel}
                    </span>
                    <strong className="mt-0.5 block font-sans text-sm text-slate-800">
                      {activePatient?.name}
                    </strong>
                    <span className="font-mono text-[10px] text-slate-400">
                      {activePatient?.phone}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block font-mono text-[10px] tracking-wider text-slate-400 uppercase">
                      Scheduled Date
                    </span>
                    <strong className="mt-0.5 block font-mono text-xs text-slate-700">
                      {activeApp.date} at {activeApp.time}
                    </strong>
                  </div>
                </div>

                {/* Pricing Line items */}
                <div className="space-y-2 text-xs text-slate-600">
                  <div className="flex justify-between">
                    <span>{activeApp.service}</span>
                    <span className="font-mono">${calculations.subtotal.toFixed(2)}</span>
                  </div>

                  {calculations.discount > 0 && (
                    <div className="flex justify-between font-semibold text-emerald-600">
                      <span className="flex items-center gap-1">
                        <Percent className="h-3 w-3" /> Promo Code applied
                      </span>
                      <span className="font-mono">-${calculations.discount.toFixed(2)}</span>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <span>Sales Tax (8.25%)</span>
                    <span className="font-mono">${calculations.tax.toFixed(2)}</span>
                  </div>

                  <div className="flex justify-between border-t border-slate-100 pt-2 text-sm font-bold text-slate-800">
                    <span>Total Due</span>
                    <span className="font-mono text-base">${calculations.total.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-100 bg-slate-50 py-12 text-center text-slate-400">
                <Receipt className="mb-2 h-8 w-8 stroke-1 text-slate-300" />
                <p className="text-xs font-semibold">
                  Select an unpaid appointment above to checkout.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Promo code form */}
        {activeApp && (
          <div>
            <form
              onSubmit={handleApplyPromo}
              className="mt-4 flex gap-2 border-t border-slate-100 pt-4"
            >
              <input
                type="text"
                placeholder="WELCOME10, GLOW20..."
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs font-medium uppercase focus:ring-1 focus:ring-teal-500 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700"
              >
                Apply
              </button>
            </form>
            {promoError && (
              <p className="mt-1 text-left font-mono text-[10px] font-bold text-rose-500">
                {promoError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Gateway checkout inputs (6 Columns) */}
      <div
        className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 lg:col-span-6"
        id="checkout-gateway-card"
      >
        {activeApp ? (
          <form
            onSubmit={handleProcessCheckout}
            className="flex flex-1 flex-col justify-between space-y-4"
          >
            <div>
              <span className="mb-3 block font-mono text-[10px] font-bold tracking-wide text-slate-400 uppercase">
                Select Secure Payment Gateway
              </span>

              {/* Gateway Selection Tabs */}
              <div className="mb-4 grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => setPaymentMethod('card')}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2 transition ${
                    paymentMethod === 'card'
                      ? 'border-slate-800 bg-slate-900 font-bold text-white'
                      : 'border-slate-150 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <CreditCard className="h-4 w-4" />
                  <span className="text-[9px]">Card</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('apple')}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2 transition ${
                    paymentMethod === 'apple'
                      ? 'border-slate-800 bg-slate-900 font-bold text-white'
                      : 'border-slate-150 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="text-[11px] font-bold tracking-tight"> Pay</span>
                  <span className="text-[9px]">Apple</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('google')}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2 transition ${
                    paymentMethod === 'google'
                      ? 'border-slate-800 bg-slate-900 font-bold text-white'
                      : 'border-slate-150 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="text-[11px] font-bold tracking-tight">G Pay</span>
                  <span className="text-[9px]">Google</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('cash')}
                  className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2 transition ${
                    paymentMethod === 'cash'
                      ? 'border-slate-800 bg-slate-900 font-bold text-white'
                      : 'border-slate-150 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <DollarSign className="h-4 w-4" />
                  <span className="text-[9px]">Cash/POS</span>
                </button>
              </div>

              {/* Secure fields layout */}
              {paymentMethod === 'card' && (
                <div className="space-y-3.5 rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                  {/* Card Number */}
                  <div>
                    <label className="mb-1 block text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                      Card Number
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        required
                        value={cardNumber}
                        onChange={(e) => setCardNumber(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white py-2 pr-10 pl-3 font-mono text-xs font-medium text-slate-700"
                      />
                      <CreditCard className="absolute top-2.5 right-3 h-4 w-4 text-slate-400" />
                    </div>
                  </div>

                  {/* Expiry & CVC */}
                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="mb-1 block text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                        Expiration
                      </label>
                      <input
                        type="text"
                        required
                        value={cardExpiry}
                        onChange={(e) => setCardExpiry(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs text-slate-700"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                        CVC
                      </label>
                      <input
                        type="text"
                        required
                        value={cardCvc}
                        onChange={(e) => setCardCvc(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs text-slate-700"
                      />
                    </div>
                  </div>

                  {/* Card Name */}
                  <div>
                    <label className="mb-1 block text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                      Cardholder Name
                    </label>
                    <input
                      type="text"
                      required
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                      placeholder="e.g. Sarah Jenkins"
                      className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-medium text-slate-700"
                    />
                  </div>
                </div>
              )}

              {paymentMethod === 'apple' && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-slate-100 bg-slate-50/50 p-8 text-center">
                  <span className="font-sans text-xl font-bold"> Pay ready</span>
                  <p className="mt-1 text-[10px] text-slate-400">
                    Tap confirmation button to authorize face ID on client side.
                  </p>
                </div>
              )}

              {paymentMethod === 'google' && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-slate-100 bg-slate-50/50 p-8 text-center">
                  <span className="text-xl font-extrabold text-slate-800">Google Pay</span>
                  <p className="mt-1 text-[10px] text-slate-400">
                    Safe tokenization verified with single click.
                  </p>
                </div>
              )}

              {paymentMethod === 'cash' && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-slate-100 bg-slate-50/50 p-8 text-center">
                  <DollarSign className="mb-1 h-8 w-8 stroke-1 text-slate-400" />
                  <span className="text-xs font-bold text-slate-800">In-Person Transaction</span>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    Collect cash or utilize adjacent card terminals.
                  </p>
                </div>
              )}
            </div>

            {/* Submission button */}
            <div className="mt-4 space-y-2.5 border-t border-slate-100 pt-4">
              <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                PCI-Compliant SSL 256-Bit Encrypted Gateways
              </div>

              <button
                type="submit"
                disabled={isProcessing}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-3 text-xs font-extrabold text-white shadow transition hover:bg-slate-800 disabled:bg-slate-600"
                id="process-payment-btn"
              >
                {isProcessing ? (
                  <span className="flex items-center gap-1">Processing Security Handshake...</span>
                ) : (
                  <>
                    Complete Settlement of ${calculations.total.toFixed(2)}{' '}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center py-20 text-center text-slate-400">
            <CreditCard className="mb-2 h-10 w-10 animate-pulse stroke-1 text-slate-300" />
            <p className="text-xs">Select active unpaid visit to enable checkout integrations.</p>
          </div>
        )}
      </div>

      {/* RENDER SUCCESS RECEIPT MODAL */}
      <AnimatePresence>
        {showReceipt && paidAppointment && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
            >
              {/* Confetti decoration */}
              <div className="flex flex-col items-center border-b border-dashed border-slate-200 pb-4 text-center">
                <div className="mb-3.5 rounded-full bg-emerald-50 p-3 text-emerald-600">
                  <Check className="h-6 w-6 stroke-[3]" />
                </div>
                <h3 className="text-base font-extrabold text-slate-800">Checkout Complete!</h3>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  Authorization token: STRIPE_TX_{Math.floor(100000 + Math.random() * 900000)}
                </p>
              </div>

              {/* Invoice body */}
              <div className="space-y-3.5 py-4 font-mono text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Merchant:</span>
                  <span className="font-bold text-slate-800">
                    {isClinic ? 'Grand Medical Practice' : 'Aurora Hair & Spa'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <span className="font-semibold text-slate-800">
                    {patients.find((p) => p.id === paidAppointment.patientId)?.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Service:</span>
                  <span className="text-right text-slate-800">{paidAppointment.service}</span>
                </div>
                <div className="border-slate-150 flex justify-between border-t border-dashed pt-3">
                  <span>Subtotal:</span>
                  <span>${paidAppointment.price.toFixed(2)}</span>
                </div>
                {discountPercentage > 0 && (
                  <div className="flex justify-between text-emerald-600">
                    <span>Discount:</span>
                    <span>-${(paidAppointment.price * (discountPercentage / 100)).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Sales Tax (8.25%):</span>
                  <span>
                    ${(paidAppointment.price * (1 - discountPercentage / 100) * 0.0825).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-3 text-sm font-bold text-slate-900">
                  <span>Grand Total Paid:</span>
                  <span>
                    ${(paidAppointment.price * (1 - discountPercentage / 100) * 1.0825).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Footer print / close */}
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReceiptStatus('Receipt dispatched to printer & download queue.');
                      setTimeout(() => setReceiptStatus(''), 4000);
                    }}
                    className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-slate-100 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200"
                  >
                    <Receipt className="h-3.5 w-3.5" /> Download PDF Receipt
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowReceipt(false);
                      setPaidAppointment(null);
                    }}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800"
                  >
                    Close
                  </button>
                </div>
                {receiptStatus && (
                  <p className="mt-1 text-center font-mono text-[10px] text-emerald-600">
                    {receiptStatus}
                  </p>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
