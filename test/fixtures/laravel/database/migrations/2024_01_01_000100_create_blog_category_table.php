<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_category', function (Blueprint $table) {
            $table->increments('id');
            $table->timestampTz('created_at')->useCurrent();
            $table->timestampTz('updated_at')->useCurrent()->useCurrentOnUpdate();
            $table->string('name', 100)->unique();
            $table->string('slug', 100);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_category');
    }
};
