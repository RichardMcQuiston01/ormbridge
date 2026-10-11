<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_profile', function (Blueprint $table): void {
            $table->id();
            $table->text('bio')->nullable();
            $table->string('avatar', 100)->nullable();
            $table->foreignId('user_id')->unique()->constrained('auth_user')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_profile');
    }
};
