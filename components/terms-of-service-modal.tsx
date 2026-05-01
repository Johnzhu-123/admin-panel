'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';

interface TermsOfServiceModalProps {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export function TermsOfServiceModal({ open, onAccept, onDecline }: TermsOfServiceModalProps) {
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [hasAgreed, setHasAgreed] = useState(false);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.target as HTMLDivElement;
    const nearBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 40;
    if (nearBottom && !hasScrolledToBottom) {
      setHasScrolledToBottom(true);
    }
  };

  const handleAccept = () => {
    if (!hasAgreed) return;
    onAccept();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDecline()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">用户协议与隐私政策确认</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            请先阅读以下内容，滚动到底后勾选同意，方可继续注册。
          </p>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4" onScroll={handleScroll}>
          <div className="space-y-6 text-sm leading-6">
            <section>
              <h3 className="text-lg font-semibold mb-2">1. 服务说明</h3>
              <p>
                本应用提供 AI 文本与图像生成、排版与导出能力。生成内容由算法输出，可能存在偏差或不完整，
                请在发布前自行审阅。
              </p>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-2">2. 合规与禁止行为</h3>
              <p>
                你不得利用本服务生成或传播违法违规、侵权、欺诈、仇恨、暴力、色情等内容，不得冒充他人、
                误导公众或绕过安全限制。
              </p>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-2">3. 隐私与数据</h3>
              <p>
                我们会按隐私政策处理账号、设备与使用数据，用于账号管理、风控、故障排查与产品改进。你可依法
                申请查询、更正或删除个人信息。
              </p>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-2">4. AI 生成内容标识</h3>
              <p>
                对外发布 AI 生成内容时，请保留或补充必要标识，避免误导。你应对最终发布内容承担法律责任。
              </p>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-2">5. 条款更新</h3>
              <p>
                我们可能根据法律法规与产品变化更新条款。继续使用即视为接受最新版本。
              </p>
            </section>

            <div className="h-16" />
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row gap-4 pt-4 border-t">
          <div className="flex items-center space-x-2 flex-1">
            <Checkbox
              id="terms"
              checked={hasAgreed}
              onCheckedChange={(checked) => setHasAgreed(checked as boolean)}
              disabled={!hasScrolledToBottom}
            />
            <label
              htmlFor="terms"
              className={`text-sm font-medium leading-none ${
                !hasScrolledToBottom ? 'text-gray-400' : 'text-gray-900'
              }`}
            >
              我已阅读并同意《用户协议》和《隐私政策》
              {!hasScrolledToBottom && (
                <span className="text-red-500 ml-1">（请先滚动到页面底部）</span>
              )}
            </label>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onDecline}>
              不同意
            </Button>
            <Button onClick={handleAccept} disabled={!hasAgreed} className="bg-blue-600 hover:bg-blue-700">
              同意并继续
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

