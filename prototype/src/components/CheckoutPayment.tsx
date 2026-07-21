import React, { useState, useMemo } from 'react';
import { CreditCard, DollarSign, Sparkles, Receipt, Check, ShoppingBag, Percent, ArrowRight, ShieldCheck } from 'lucide-react';
import { Appointment, Patient, WorkspaceMode } from '../types';
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="checkout-payment-root">
      {/* Checkout Selector & Totals (6 Columns) */}
      <div className="lg:col-span-6 bg-white p-6 rounded-xl border border-slate-200 flex flex-col justify-between" id="checkout-totals-card">
        <div>
          <div className="flex items-center gap-2 mb-4">
            <div className={`p-2 rounded-lg ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}>
              <ShoppingBag className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Checkout Terminal</h3>
              <p className="text-[10px] text-slate-400">Process secure point-of-sale customer settlement</p>
            </div>
          </div>

          {/* Selector input */}
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-500 font-bold block mb-1">
                Select Active Unpaid Visit
              </label>
              <select
                value={selectedAppId}
                onChange={(e) => setSelectedAppId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-700"
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
              <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50 space-y-3.5">
                <div className="flex justify-between items-start text-xs border-b border-slate-100 pb-2.5">
                  <div>
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">
                      {patientLabel}
                    </span>
                    <strong className="text-slate-800 font-sans text-sm block mt-0.5">
                      {activePatient?.name}
                    </strong>
                    <span className="text-[10px] font-mono text-slate-400">{activePatient?.phone}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">
                      Scheduled Date
                    </span>
                    <strong className="text-slate-700 text-xs block mt-0.5 font-mono">
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
                    <div className="flex justify-between text-emerald-600 font-semibold">
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

                  <div className="flex justify-between text-sm font-bold text-slate-800 border-t border-slate-100 pt-2">
                    <span>Total Due</span>
                    <span className="font-mono text-base">${calculations.total.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-slate-400 bg-slate-50 border border-slate-100 border-dashed rounded-xl flex flex-col items-center">
                <Receipt className="h-8 w-8 stroke-1 text-slate-300 mb-2" />
                <p className="text-xs font-semibold">Select an unpaid appointment above to checkout.</p>
              </div>
            )}
          </div>
        </div>

        {/* Promo code form */}
        {activeApp && (
          <div>
            <form onSubmit={handleApplyPromo} className="flex gap-2 border-t border-slate-100 pt-4 mt-4">
              <input
                type="text"
                placeholder="WELCOME10, GLOW20..."
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500 uppercase font-mono font-medium"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-lg text-xs"
              >
                Apply
              </button>
            </form>
            {promoError && (
              <p className="text-[10px] text-rose-500 font-bold mt-1 text-left font-mono">{promoError}</p>
            )}
          </div>
        )}
      </div>

      {/* Gateway checkout inputs (6 Columns) */}
      <div className="lg:col-span-6 bg-white p-6 rounded-xl border border-slate-200 flex flex-col justify-between" id="checkout-gateway-card">
        {activeApp ? (
          <form onSubmit={handleProcessCheckout} className="space-y-4 flex-1 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wide block mb-3">
                Select Secure Payment Gateway
              </span>

              {/* Gateway Selection Tabs */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                <button
                  type="button"
                  onClick={() => setPaymentMethod('card')}
                  className={`py-2 border rounded-xl flex flex-col items-center justify-center gap-1 transition ${
                    paymentMethod === 'card'
                      ? 'border-slate-800 bg-slate-900 text-white font-bold'
                      : 'border-slate-150 hover:bg-slate-50 text-slate-600'
                  }`}
                >
                  <CreditCard className="h-4 w-4" />
                  <span className="text-[9px]">Card</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('apple')}
                  className={`py-2 border rounded-xl flex flex-col items-center justify-center gap-1 transition ${
                    paymentMethod === 'apple'
                      ? 'border-slate-800 bg-slate-900 text-white font-bold'
                      : 'border-slate-150 hover:bg-slate-50 text-slate-600'
                  }`}
                >
                  <span className="font-bold text-[11px] tracking-tight"> Pay</span>
                  <span className="text-[9px]">Apple</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('google')}
                  className={`py-2 border rounded-xl flex flex-col items-center justify-center gap-1 transition ${
                    paymentMethod === 'google'
                      ? 'border-slate-800 bg-slate-900 text-white font-bold'
                      : 'border-slate-150 hover:bg-slate-50 text-slate-600'
                  }`}
                >
                  <span className="font-bold text-[11px] tracking-tight">G Pay</span>
                  <span className="text-[9px]">Google</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('cash')}
                  className={`py-2 border rounded-xl flex flex-col items-center justify-center gap-1 transition ${
                    paymentMethod === 'cash'
                      ? 'border-slate-800 bg-slate-900 text-white font-bold'
                      : 'border-slate-150 hover:bg-slate-50 text-slate-600'
                  }`}
                >
                  <DollarSign className="h-4 w-4" />
                  <span className="text-[9px]">Cash/POS</span>
                </button>
              </div>

              {/* Secure fields layout */}
              {paymentMethod === 'card' && (
                <div className="space-y-3.5 border border-slate-100 bg-slate-50/50 p-4 rounded-xl">
                  {/* Card Number */}
                  <div>
                    <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase tracking-wider">Card Number</label>
                    <div className="relative">
                      <input
                        type="text"
                        required
                        value={cardNumber}
                        onChange={(e) => setCardNumber(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg pl-3 pr-10 py-2 text-xs font-mono font-medium text-slate-700"
                      />
                      <CreditCard className="absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
                    </div>
                  </div>

                  {/* Expiry & CVC */}
                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase tracking-wider">Expiration</label>
                      <input
                        type="text"
                        required
                        value={cardExpiry}
                        onChange={(e) => setCardExpiry(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono text-slate-700"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase tracking-wider">CVC</label>
                      <input
                        type="text"
                        required
                        value={cardCvc}
                        onChange={(e) => setCardCvc(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono text-slate-700"
                      />
                    </div>
                  </div>

                  {/* Card Name */}
                  <div>
                    <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase tracking-wider">Cardholder Name</label>
                    <input
                      type="text"
                      required
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                      placeholder="e.g. Sarah Jenkins"
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs text-slate-700 font-medium"
                    />
                  </div>
                </div>
              )}

              {paymentMethod === 'apple' && (
                <div className="p-8 border border-slate-100 bg-slate-50/50 rounded-xl text-center flex flex-col items-center justify-center">
                  <span className="text-xl font-bold font-sans"> Pay ready</span>
                  <p className="text-[10px] text-slate-400 mt-1">Tap confirmation button to authorize face ID on client side.</p>
                </div>
              )}

              {paymentMethod === 'google' && (
                <div className="p-8 border border-slate-100 bg-slate-50/50 rounded-xl text-center flex flex-col items-center justify-center">
                  <span className="text-xl font-extrabold text-slate-800">Google Pay</span>
                  <p className="text-[10px] text-slate-400 mt-1">Safe tokenization verified with single click.</p>
                </div>
              )}

              {paymentMethod === 'cash' && (
                <div className="p-8 border border-slate-100 bg-slate-50/50 rounded-xl text-center flex flex-col items-center justify-center">
                  <DollarSign className="h-8 w-8 text-slate-400 stroke-1 mb-1" />
                  <span className="text-xs font-bold text-slate-800">In-Person Transaction</span>
                  <p className="text-[10px] text-slate-400 mt-0.5">Collect cash or utilize adjacent card terminals.</p>
                </div>
              )}
            </div>

            {/* Submission button */}
            <div className="pt-4 border-t border-slate-100 mt-4 space-y-2.5">
              <div className="flex items-center gap-1.5 justify-center text-[10px] text-slate-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                PCI-Compliant SSL 256-Bit Encrypted Gateways
              </div>

              <button
                type="submit"
                disabled={isProcessing}
                className="w-full flex items-center justify-center gap-1.5 px-4 py-3 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-600 text-white font-extrabold text-xs rounded-xl shadow transition"
                id="process-payment-btn"
              >
                {isProcessing ? (
                  <span className="flex items-center gap-1">
                    Processing Security Handshake...
                  </span>
                ) : (
                  <>
                    Complete Settlement of ${calculations.total.toFixed(2)} <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-center py-20">
            <CreditCard className="h-10 w-10 stroke-1 text-slate-300 mb-2 animate-pulse" />
            <p className="text-xs">Select active unpaid visit to enable checkout integrations.</p>
          </div>
        )}
      </div>

      {/* RENDER SUCCESS RECEIPT MODAL */}
      <AnimatePresence>
        {showReceipt && paidAppointment && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl w-full max-w-sm p-6 border border-slate-200 shadow-lg relative"
            >
              {/* Confetti decoration */}
              <div className="flex flex-col items-center text-center pb-4 border-b border-dashed border-slate-200">
                <div className="p-3 bg-emerald-50 text-emerald-600 rounded-full mb-3.5">
                  <Check className="h-6 w-6 stroke-[3]" />
                </div>
                <h3 className="text-base font-extrabold text-slate-800">Checkout Complete!</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Authorization token: STRIPE_TX_{Math.floor(100000 + Math.random() * 900000)}</p>
              </div>

              {/* Invoice body */}
              <div className="py-4 space-y-3.5 text-xs text-slate-600 font-mono">
                <div className="flex justify-between">
                  <span>Merchant:</span>
                  <span className="font-bold text-slate-800">{isClinic ? 'Grand Medical Practice' : 'Aurora Hair & Spa'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <span className="font-semibold text-slate-800">{patients.find((p) => p.id === paidAppointment.patientId)?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span>Service:</span>
                  <span className="text-slate-800 text-right">{paidAppointment.service}</span>
                </div>
                <div className="flex justify-between border-t border-dashed border-slate-150 pt-3">
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
                  <span>${(paidAppointment.price * (1 - discountPercentage / 100) * 0.0825).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-900 font-bold text-sm border-t border-slate-200 pt-3">
                  <span>Grand Total Paid:</span>
                  <span>${(paidAppointment.price * (1 - discountPercentage / 100) * 1.0825).toFixed(2)}</span>
                </div>
              </div>

              {/* Footer print / close */}
              <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReceiptStatus('Receipt dispatched to printer & download queue.');
                      setTimeout(() => setReceiptStatus(''), 4000);
                    }}
                    className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl flex items-center justify-center gap-1"
                  >
                    <Receipt className="h-3.5 w-3.5" /> Download PDF Receipt
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowReceipt(false);
                      setPaidAppointment(null);
                    }}
                    className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl"
                  >
                    Close
                  </button>
                </div>
                {receiptStatus && (
                  <p className="text-[10px] text-emerald-600 font-mono text-center mt-1">{receiptStatus}</p>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
