<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Category extends Model
{
    public $incrementing = false;

    /** @var list<string> */
    protected $fillable = [
        'id',
        'name',
        'slug',
        'parent_id',
    ];
}
