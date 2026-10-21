<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('Tag', function (Blueprint $table): void {
            $table->integer('id')->primary();
            $table->string('label', 50);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('Tag');
    }
};
