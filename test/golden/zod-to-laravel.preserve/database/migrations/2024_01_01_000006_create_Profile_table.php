<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('Profile', function (Blueprint $table): void {
            $table->integer('id')->primary();
            $table->text('bio')->nullable();
            $table->string('avatar', 100)->nullable();
            $table->integer('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('Profile');
    }
};
